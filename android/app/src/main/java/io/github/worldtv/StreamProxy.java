package io.github.worldtv;

import android.content.Context;
import android.content.res.AssetManager;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Serves the bundled web app and fetches streams natively.
 *
 * Browsers only let a web page read a stream if the TV station's server
 * allows it (CORS) and, on https pages, only over https. Fetching here and
 * adding the permission header ourselves removes both limits, so far more
 * channels play in the app than on the website.
 */
class StreamProxy {
    private static final int MAX_REDIRECTS = 6;
    private static final Pattern URI_ATTR = Pattern.compile("URI=\"([^\"]+)\"");

    private final AssetManager assets;

    StreamProxy(Context ctx) {
        assets = ctx.getAssets();
    }

    void shutdown() { }

    WebResourceResponse handle(WebResourceRequest req) {
        Uri u = req.getUrl();
        String host = u.getHost() == null ? "" : u.getHost();
        String scheme = u.getScheme() == null ? "" : u.getScheme();

        if (MainActivity.HOST.equals(host)) return asset(u.getPath());

        // Use the player libraries bundled in the APK instead of the CDN.
        if ("cdn.jsdelivr.net".equals(host)) {
            String p = u.getPath() == null ? "" : u.getPath();
            if (p.contains("/hls.js@")) return assetFile("www/vendor/hls.min.js");
            if (p.contains("/dashjs@")) return assetFile("www/vendor/dash.all.min.js");
        }

        if (!scheme.startsWith("http") || req.isForMainFrame()) return null;
        String method = req.getMethod();
        if ("OPTIONS".equalsIgnoreCase(method)) return preflight();
        if (!"GET".equalsIgnoreCase(method)) return null;
        if (isImage(req)) return null; // images don't need any help

        return fetch(u.toString(), req.getRequestHeaders());
    }

    // ---------- bundled files ----------
    private WebResourceResponse asset(String path) {
        if (path == null || path.equals("/") || path.isEmpty()) path = "/index.html";
        if (path.contains("..")) return notFound();
        return assetFile("www" + path);
    }

    private WebResourceResponse assetFile(String name) {
        try {
            InputStream in = assets.open(name);
            WebResourceResponse r = new WebResourceResponse(mime(name), mime(name).startsWith("text") || name.endsWith(".js") || name.endsWith(".json") ? "utf-8" : null, in);
            Map<String, String> h = new HashMap<>();
            h.put("Access-Control-Allow-Origin", "*");
            h.put("Cache-Control", "no-cache");
            r.setResponseHeaders(h);
            return r;
        } catch (IOException e) {
            return notFound();
        }
    }

    private static String mime(String name) {
        String n = name.toLowerCase(Locale.ROOT);
        if (n.endsWith(".html")) return "text/html";
        if (n.endsWith(".css")) return "text/css";
        if (n.endsWith(".js") || n.endsWith(".mjs")) return "text/javascript";
        if (n.endsWith(".json") || n.endsWith(".webmanifest")) return "application/json";
        if (n.endsWith(".svg")) return "image/svg+xml";
        if (n.endsWith(".png")) return "image/png";
        return "application/octet-stream";
    }

    private static boolean isImage(WebResourceRequest req) {
        String accept = header(req.getRequestHeaders(), "Accept");
        return accept != null && accept.startsWith("image/");
    }

    private static String header(Map<String, String> h, String name) {
        for (Map.Entry<String, String> e : h.entrySet()) if (e.getKey().equalsIgnoreCase(name)) return e.getValue();
        return null;
    }

    // ---------- network ----------
    private WebResourceResponse fetch(String url, Map<String, String> reqHeaders) {
        HttpURLConnection c = null;
        String current = url;
        try {
            for (int i = 0; i <= MAX_REDIRECTS; i++) {
                c = (HttpURLConnection) new URL(current).openConnection();
                c.setInstanceFollowRedirects(false);
                c.setConnectTimeout(10000);
                c.setReadTimeout(20000);
                for (Map.Entry<String, String> e : reqHeaders.entrySet()) {
                    String k = e.getKey().toLowerCase(Locale.ROOT);
                    // Leave out headers that reveal the in-app page or break decoding.
                    if (k.equals("origin") || k.equals("referer") || k.equals("accept-encoding")
                            || k.equals("host") || k.startsWith("if-") || k.startsWith("sec-")) continue;
                    c.setRequestProperty(e.getKey(), e.getValue());
                }
                int code = c.getResponseCode();
                if (code >= 300 && code < 400 && c.getHeaderField("Location") != null) {
                    current = new URL(new URL(current), c.getHeaderField("Location")).toString();
                    c.disconnect();
                    continue;
                }
                return respond(c, code, url, current);
            }
            return error(508, "Too many redirects");
        } catch (Exception e) {
            if (c != null) c.disconnect();
            return error(502, "Bad Gateway");
        }
    }

    private WebResourceResponse respond(HttpURLConnection c, int code, String requested, String finalUrl) throws IOException {
        if (code < 100 || (code >= 300 && code < 400) || code > 599) code = 502;
        String type = c.getContentType();
        String mimeType = "application/octet-stream";
        String charset = null;
        if (type != null) {
            String[] parts = type.split(";");
            mimeType = parts[0].trim();
            for (String p : parts) {
                p = p.trim();
                if (p.toLowerCase(Locale.ROOT).startsWith("charset=")) charset = p.substring(8).replace("\"", "");
            }
        }

        InputStream body = code >= 400 ? c.getErrorStream() : c.getInputStream();
        if (body == null) body = new ByteArrayInputStream(new byte[0]);

        // If the playlist was redirected, make its relative links absolute so the
        // player fetches segments from the right server.
        if (code < 400 && !requested.equals(finalUrl) && looksLikePlaylist(mimeType, finalUrl)) {
            String text = new String(readAll(body), StandardCharsets.UTF_8);
            if (text.startsWith("#EXTM3U")) text = absolutize(text, finalUrl);
            body = new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8));
            charset = "utf-8";
        }

        Map<String, String> headers = new HashMap<>();
        for (Map.Entry<String, List<String>> e : c.getHeaderFields().entrySet()) {
            String k = e.getKey();
            if (k == null || e.getValue() == null || e.getValue().isEmpty()) continue;
            String lk = k.toLowerCase(Locale.ROOT);
            if (lk.equals("content-encoding") || lk.equals("content-length") || lk.equals("transfer-encoding")
                    || lk.equals("connection") || lk.equals("set-cookie") || lk.startsWith("access-control-")) continue;
            headers.put(k, e.getValue().get(0));
        }
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put("Access-Control-Expose-Headers", "*");

        String reason = c.getResponseMessage();
        if (reason == null || reason.trim().isEmpty()) reason = code < 400 ? "OK" : "Error";
        return new WebResourceResponse(mimeType, charset, code, reason, headers, body);
    }

    private static boolean looksLikePlaylist(String mime, String url) {
        String m = mime.toLowerCase(Locale.ROOT);
        String path = Uri.parse(url).getPath();
        return m.contains("mpegurl") || (path != null && path.toLowerCase(Locale.ROOT).endsWith(".m3u8"));
    }

    static String absolutize(String playlist, String base) {
        URI b = URI.create(base);
        StringBuilder out = new StringBuilder();
        for (String line : playlist.split("\r?\n", -1)) {
            String t = line.trim();
            if (!t.isEmpty() && !t.startsWith("#")) {
                out.append(resolve(b, t));
            } else if (t.startsWith("#") && t.contains("URI=\"")) {
                Matcher m = URI_ATTR.matcher(line);
                StringBuffer sb = new StringBuffer();
                while (m.find()) m.appendReplacement(sb, Matcher.quoteReplacement("URI=\"" + resolve(b, m.group(1)) + "\""));
                m.appendTail(sb);
                out.append(sb);
            } else {
                out.append(line);
            }
            out.append('\n');
        }
        return out.toString();
    }

    private static String resolve(URI base, String ref) {
        try { return base.resolve(ref.replace(" ", "%20")).toString(); }
        catch (Exception e) { return ref; }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
        in.close();
        return bo.toByteArray();
    }

    private static WebResourceResponse preflight() {
        Map<String, String> h = new HashMap<>();
        h.put("Access-Control-Allow-Origin", "*");
        h.put("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        h.put("Access-Control-Allow-Headers", "*");
        h.put("Access-Control-Max-Age", "86400");
        return new WebResourceResponse("text/plain", "utf-8", 204, "No Content", h, new ByteArrayInputStream(new byte[0]));
    }

    private static WebResourceResponse error(int code, String reason) {
        Map<String, String> h = new HashMap<>();
        h.put("Access-Control-Allow-Origin", "*");
        return new WebResourceResponse("text/plain", "utf-8", code, reason, h, new ByteArrayInputStream(new byte[0]));
    }

    private static WebResourceResponse notFound() { return error(404, "Not Found"); }
}
