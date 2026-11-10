package io.github.worldtv;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.PictureInPictureParams;
import android.app.UiModeManager;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.speech.RecognizerIntent;
import android.view.inputmethod.InputMethodManager;
import java.util.ArrayList;
import org.json.JSONObject;
import android.util.Rational;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

/**
 * Hosts the Zapply web app in a WebView. The page is served from the APK's
 * assets, and stream requests go through {@link StreamProxy} so that channels
 * whose servers block web players (or use plain http) still play.
 */
public class MainActivity extends Activity {
    static final String HOST = "appassets.androidplatform.net";
    static final String START_URL = "https://" + HOST + "/index.html";
    static final String SITE = "https://nexeerp-dev.github.io/iptv/";

    private WebView web;
    private FrameLayout root;
    private View customView;
    private WebChromeClient.CustomViewCallback customCallback;
    private volatile boolean playing = false;
    private StreamProxy proxy;
    private boolean isTv;
    private static final int VOICE_REQUEST = 41;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        proxy = new StreamProxy(this);
        UiModeManager ui = getSystemService(UiModeManager.class);
        isTv = (ui != null && ui.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION)
                || getPackageManager().hasSystemFeature("android.software.leanback")
                || getPackageManager().hasSystemFeature("amazon.hardware.fire_tv");

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0B0D14"));
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0B0D14"));
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        // Keep content clear of the status and navigation bars (Android 15 draws edge to edge).
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            if (customView == null) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            } else {
                v.setPadding(0, 0, 0, 0);
            }
            return WindowInsets.CONSUMED;
        });

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setAllowFileAccess(false);
        s.setSupportMultipleWindows(false);
        s.setUserAgentString(s.getUserAgentString() + " WorldTVApp/1.0");

        web.addJavascriptInterface(new Bridge(), "WorldTVAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                return proxy.handle(req);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (HOST.equals(u.getHost())) return false;
                openExternal(u.toString());
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                enterFullscreen(view, callback);
            }

            @Override
            public void onHideCustomView() {
                exitFullscreen();
            }
        });

        web.setFocusable(true);
        web.setFocusableInTouchMode(true);
        web.requestFocus();

        if (state != null) web.restoreState(state);
        else web.loadUrl(startUrlFor(getIntent()));
    }

    /** Turns a website link (…/iptv/#ch=xyz) into the same view inside the app. */
    private String startUrlFor(Intent intent) {
        Uri data = intent != null ? intent.getData() : null;
        if (data != null && data.getFragment() != null) return START_URL + "#" + data.getEncodedFragment();
        return START_URL;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent.getData() != null) web.loadUrl(startUrlFor(intent));
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    // ---------- fullscreen ----------
    private void enterFullscreen(View view, WebChromeClient.CustomViewCallback cb) {
        if (customView != null) { cb.onCustomViewHidden(); return; }
        customView = view;
        customCallback = cb;
        root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.setVisibility(View.GONE);
        setSystemBarsHidden(true);
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
        root.requestApplyInsets();
    }

    private void exitFullscreen() {
        if (customView == null) return;
        root.removeView(customView);
        customView = null;
        web.setVisibility(View.VISIBLE);
        setSystemBarsHidden(false);
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        if (customCallback != null) customCallback.onCustomViewHidden();
        customCallback = null;
        root.requestApplyInsets();
    }

    private void setSystemBarsHidden(boolean on) {
        WindowInsetsController c = getWindow().getInsetsController();
        if (c == null) return;
        if (on) {
            c.hide(WindowInsets.Type.systemBars());
            c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        } else {
            c.show(WindowInsets.Type.systemBars());
        }
    }

    // ---------- picture-in-picture ----------
    private void enterPip() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        try {
            enterPictureInPictureMode(new PictureInPictureParams.Builder()
                    .setAspectRatio(new Rational(16, 9)).build());
        } catch (IllegalStateException | IllegalArgumentException e) {
            toast("Mini player is not available on this device");
        }
    }

    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        // Going home while a channel plays: keep watching in a small window.
        if (playing && !isTv) {
            web.evaluateJavascript("window.WorldTVNative && WorldTVNative.goFullscreen()", null);
            enterPip();
        }
    }

    @Override
    public void onPictureInPictureModeChanged(boolean inPip, Configuration cfg) {
        super.onPictureInPictureModeChanged(inPip, cfg);
        if (!inPip && customView != null && !isFinishing()) {
            // Back from the mini window: return to the normal layout.
            web.evaluateJavascript("document.fullscreenElement && document.exitFullscreen()", null);
        }
    }

    // ---------- back button / keys ----------
    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        if (customView != null) {
            web.evaluateJavascript("document.exitFullscreen && document.exitFullscreen()", null);
            exitFullscreen();
            return;
        }
        web.evaluateJavascript("window.WorldTVNative ? WorldTVNative.back() : false", value -> {
            if (!"true".equals(value)) finish();
        });
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        // TV remotes: channel buttons switch channels.
        if (e.getAction() == KeyEvent.ACTION_DOWN) {
            int k = e.getKeyCode();
            if (k == KeyEvent.KEYCODE_CHANNEL_UP || k == KeyEvent.KEYCODE_MEDIA_NEXT) { js("WorldTVNative.step(1)"); return true; }
            if (k == KeyEvent.KEYCODE_CHANNEL_DOWN || k == KeyEvent.KEYCODE_MEDIA_PREVIOUS) { js("WorldTVNative.step(-1)"); return true; }
            if (k == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE || k == KeyEvent.KEYCODE_MEDIA_PLAY || k == KeyEvent.KEYCODE_MEDIA_PAUSE) { js("WorldTVNative.playPause()"); return true; }
            if (k == KeyEvent.KEYCODE_GUIDE || k == KeyEvent.KEYCODE_TV_INPUT || k == KeyEvent.KEYCODE_PROG_RED) { js("WorldTVNative.guide()"); return true; }
            if (k == KeyEvent.KEYCODE_MENU || k == KeyEvent.KEYCODE_SETTINGS) { js("WorldTVNative.menu()"); return true; }
            if (k == KeyEvent.KEYCODE_SEARCH || k == KeyEvent.KEYCODE_VOICE_ASSIST) { startVoiceSearch(); return true; }
        }
        return super.dispatchKeyEvent(e);
    }

    private void js(String code) {
        web.evaluateJavascript("window.WorldTVNative && " + code, null);
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (!isInPictureInPictureMode()) web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onStop() {
        super.onStop();
        // Leaving the app without the mini window: stop playback to save data.
        if (!isInPictureInPictureMode()) js("WorldTVNative.pause()");
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        proxy.shutdown();
        super.onDestroy();
    }

    // ---------- voice search ----------
    void startVoiceSearch() {
        runOnUiThread(() -> {
            Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            i.putExtra(RecognizerIntent.EXTRA_PROMPT, "Say a channel, country or category");
            try {
                startActivityForResult(i, VOICE_REQUEST);
            } catch (ActivityNotFoundException e) {
                toast("Voice search is not available on this device");
            }
        });
    }

    @SuppressWarnings("deprecation")
    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != VOICE_REQUEST || result != RESULT_OK || data == null) return;
        ArrayList<String> said = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
        if (said == null || said.isEmpty()) return;
        web.evaluateJavascript("window.WorldTVNative && WorldTVNative.search(" + JSONObject.quote(said.get(0)) + ")", null);
    }

    // ---------- helpers ----------
    void openExternal(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (ActivityNotFoundException e) {
            toast("No app can open this link");
        }
    }

    void toast(String msg) {
        runOnUiThread(() -> Toast.makeText(this, msg, Toast.LENGTH_SHORT).show());
    }

    /** Methods the web app can call as window.WorldTVAndroid.*. */
    class Bridge {
        @JavascriptInterface public boolean isApp() { return true; }
        @JavascriptInterface public boolean isTV() { return isTv; }
        @JavascriptInterface public void voiceSearch() { startVoiceSearch(); }

        /** Opens the on-screen keyboard for the focused text box (TV remotes). */
        @JavascriptInterface
        public void showKeyboard() {
            runOnUiThread(() -> {
                web.requestFocus();
                InputMethodManager imm = getSystemService(InputMethodManager.class);
                if (imm != null) imm.showSoftInput(web, InputMethodManager.SHOW_IMPLICIT);
            });
        }
        @JavascriptInterface public String siteUrl() { return SITE; }

        @JavascriptInterface
        public void setPlaying(boolean on) {
            playing = on;
            runOnUiThread(() -> {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }

        @JavascriptInterface
        public void pip() { runOnUiThread(MainActivity.this::enterPip); }

        @JavascriptInterface
        public void share(String title, String text) {
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_SEND);
                i.setType("text/plain");
                i.putExtra(Intent.EXTRA_SUBJECT, title);
                i.putExtra(Intent.EXTRA_TEXT, text);
                startActivity(Intent.createChooser(i, title));
            });
        }

        @JavascriptInterface
        public void copy(String text, String msg) {
            runOnUiThread(() -> {
                ClipboardManager cm = getSystemService(ClipboardManager.class);
                cm.setPrimaryClip(ClipData.newPlainText("Zapply", text));
                if (Build.VERSION.SDK_INT < 33) toast(msg);
            });
        }

        /** Opens a stream in another installed player such as VLC or MX Player. */
        @JavascriptInterface
        public void openInPlayer(String url, String title) {
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_VIEW);
                i.setDataAndType(Uri.parse(url), "video/*");
                i.putExtra("title", title);
                try { startActivity(Intent.createChooser(i, "Open with")); }
                catch (ActivityNotFoundException e) { toast("No video player app found"); }
            });
        }

        @JavascriptInterface
        public void openExternal(String url) { MainActivity.this.openExternal(url); }
    }
}
