package com.kiosk.player.ui

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebViewDatabase
import android.widget.TextView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.kiosk.core.model.PinHash
import com.kiosk.core.model.WebKioskSettings
import com.kiosk.core.player.WebKioskRules
import com.kiosk.player.KioskInput
import kotlinx.coroutines.delay

// A Web Kiosk (0.12.0): the playlist plays while nobody touches the screen; a touch opens
// the screen's web page. Customers stay on that website (and the ones allowed on the
// dashboard); downloads, pop-up windows, files, the camera, microphone and location are
// refused. After the idle time untouched, or on Start over, everything the customer did
// (cookies, logins, storage, cache, history, form data) is wiped. The same rules as the
// Windows Kiosk Browser (windows/src/main.js).

/** "Touch the screen to start", over the playlist. A tap anywhere but the staff corner opens the page. */
@Composable
fun TouchToStart(onStart: () -> Unit) {
    val density = LocalDensity.current.density
    Box(
        Modifier.fillMaxSize().pointerInput(Unit) {
            detectTapGestures(onTap = { at -> if (!KioskInput.inCorner(at.x, at.y, density)) onStart() })
        },
        contentAlignment = Alignment.BottomCenter,
    ) {
        Row(
            Modifier.padding(bottom = 40.dp)
                .background(Color(0xE029241E), RoundedCornerShape(40.dp))
                .border(2.dp, Accent, RoundedCornerShape(40.dp))
                .padding(horizontal = 28.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Box(Modifier.size(10.dp).background(Accent, CircleShape))
            Text("Touch the screen to start", fontSize = 24.sp, fontWeight = FontWeight.SemiBold, color = Cream)
        }
    }
}

/** The customer's web page, with Back and Start over underneath. [onEnd] goes back to the playlist. */
@Composable
fun WebKioskSession(settings: WebKioskSettings, onEnd: () -> Unit) {
    val start = settings.url ?: return
    var notice by remember { mutableStateOf<String?>(null) }
    var web by remember { mutableStateOf<KioskWebView?>(null) }

    // Back to the playlist after the idle time with nobody touching or typing anywhere.
    LaunchedEffect(settings.idleSeconds) {
        KioskInput.active()
        val idleMs = settings.idleSeconds.coerceAtLeast(15) * 1000L
        while (true) {
            delay(1_000)
            if (System.currentTimeMillis() - KioskInput.lastActivity > idleMs) {
                onEnd()
                break
            }
        }
    }
    LaunchedEffect(notice) {
        if (notice != null) {
            delay(4_000)
            notice = null
        }
    }

    Box(Modifier.fillMaxSize().background(Ink)) {
        Column(Modifier.fillMaxSize().imePadding()) {
            AndroidView(
                factory = { context ->
                    createKioskWebView(
                        context, settings,
                        onRefused = { notice = it },
                        onGone = onEnd,
                    )?.also { web = it; it.loadUrl(start) }
                        ?: TextView(context).apply {
                            text = "This screen can’t show web pages: Android System WebView is missing or switched off."
                            setTextColor(android.graphics.Color.WHITE)
                            textSize = 22f
                            setPadding(48, 48, 48, 48)
                        }
                },
                onRelease = { view ->
                    if (view is WebView) {
                        wipeWebData(view.context, view)
                        runCatching { view.destroy() }
                    }
                },
                modifier = Modifier.weight(1f).fillMaxWidth(),
            )
            Row(
                Modifier.fillMaxWidth().height(76.dp).background(Color(0xFF221E19)).padding(horizontal = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                TvButton("‹ Back", {
                    KioskInput.active()
                    web?.let { if (it.canGoBack()) it.goBack() }
                }, small = true)
                TvButton("Start over", {
                    KioskInput.active()
                    web?.let { view ->
                        wipeWebData(view.context, view)
                        view.startFresh(start)
                    }
                }, primary = true, small = true)
                Spacer(Modifier.weight(1f))
                Text("Untouched for ${settings.idleSeconds} seconds: back to the start", fontSize = 15.sp, color = Muted)
            }
        }
        notice?.let {
            Box(Modifier.fillMaxSize().padding(bottom = 96.dp), contentAlignment = Alignment.BottomCenter) {
                Text(
                    it, fontSize = 20.sp, color = Cream,
                    modifier = Modifier.background(Color(0xFF332D26), RoundedCornerShape(8.dp))
                        .border(1.dp, Line, RoundedCornerShape(8.dp)).padding(horizontal = 22.dp, vertical = 14.dp),
                )
            }
        }
    }
}

/** A web viewer that also counts typing on the on-screen keyboard (in any frame) as activity. */
class KioskWebView(context: Context) : WebView(context) {
    private var clearHistoryWhenLoaded = false

    /** Start over: the start page, with no way Back to the last customer's pages. */
    fun startFresh(start: String) {
        stopLoading()
        clearHistoryWhenLoaded = true
        loadUrl(start)
    }

    internal fun pageFinished() {
        if (clearHistoryWhenLoaded) {
            clearHistoryWhenLoaded = false
            clearHistory()
        }
    }

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
        val inner = super.onCreateInputConnection(outAttrs) ?: return null
        return object : InputConnectionWrapper(inner, true) {
            override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
                KioskInput.active(); return super.commitText(text, newCursorPosition)
            }
            override fun setComposingText(text: CharSequence?, newCursorPosition: Int): Boolean {
                KioskInput.active(); return super.setComposingText(text, newCursorPosition)
            }
            override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
                KioskInput.active(); return super.deleteSurroundingText(beforeLength, afterLength)
            }
            override fun sendKeyEvent(event: KeyEvent?): Boolean {
                KioskInput.active(); return super.sendKeyEvent(event)
            }
        }
    }
}

/** The web viewer with the kiosk's rules, or null when this box has no working web viewer. */
@SuppressLint("SetJavaScriptEnabled")
private fun createKioskWebView(
    context: Context,
    kiosk: WebKioskSettings,
    onRefused: (String) -> Unit,
    onGone: () -> Unit,
): KioskWebView? {
    val start = kiosk.url ?: return null
    val web = runCatching { KioskWebView(context) }.getOrNull() ?: return null
    web.settings.apply {
        javaScriptEnabled = true
        domStorageEnabled = true
        allowFileAccess = false
        allowContentAccess = false
        // "Open in a new window" opens in this same view, through the same rules.
        setSupportMultipleWindows(false)
        javaScriptCanOpenWindowsAutomatically = false
        setGeolocationEnabled(false)
        mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        mediaPlaybackRequiresUserGesture = true
        useWideViewPort = true
        loadWithOverviewMode = true
        builtInZoomControls = true
        displayZoomControls = false
    }
    web.isFocusable = true
    web.isFocusableInTouchMode = true
    web.webViewClient = object : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            // Embedded frames (payment boxes, maps) may come from elsewhere; the page itself may not.
            if (!request.isForMainFrame) return false
            val allowed = WebKioskRules.isAllowed(request.url.toString(), start, kiosk.allowedHosts)
            if (!allowed) onRefused("That page isn’t available on this kiosk.")
            return !allowed
        }

        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
            // A page reached some other way (a script, a form) that isn't allowed: back to the start.
            // (Never for the start page itself, so an odd address can't loop.)
            if (url != start && !WebKioskRules.isAllowed(url, start, kiosk.allowedHosts)) {
                view.stopLoading()
                onRefused("That page isn’t available on this kiosk.")
                (view as? KioskWebView)?.startFresh(start)
            }
        }

        override fun onPageFinished(view: WebView, url: String) {
            (view as? KioskWebView)?.pageFinished()
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) onRefused("The page didn’t load. Check the internet connection, or tap Start over.")
        }

        // The web viewer crashed or was stopped to free memory: back to the playlist instead of closing the app.
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            onGone()
            return true
        }
    }
    web.webChromeClient = object : WebChromeClient() {
        override fun onPermissionRequest(request: PermissionRequest) = request.deny()
        override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) =
            callback.invoke(origin, false, false)
        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<android.net.Uri>>, params: WebChromeClient.FileChooserParams): Boolean {
            callback.onReceiveValue(null)
            onRefused("Choosing files isn’t available on this kiosk.")
            return true
        }
    }
    web.setDownloadListener { _, _, _, _, _ -> onRefused("Downloads aren’t available on this kiosk.") }
    return web
}

/** Everything a customer left behind: cookies, logins, storage, cache, history, form data. */
fun wipeWebData(context: Context, web: WebView?) {
    runCatching {
        web?.apply {
            stopLoading()
            clearHistory()
            clearFormData()
            clearCache(true)
        }
    }
    runCatching {
        CookieManager.getInstance().removeAllCookies(null)
        CookieManager.getInstance().flush()
    }
    runCatching { WebStorage.getInstance().deleteAllData() }
    runCatching { WebViewDatabase.getInstance(context).clearHttpAuthUsernamePassword() }
}

/** The staff PIN pad (after 5 quick taps in the top-left corner). */
@Composable
fun StaffPinPad(pin: PinHash, onRight: () -> Unit, onCancel: () -> Unit) {
    var typed by remember { mutableStateOf("") }
    var wrong by remember { mutableStateOf(false) }
    Box(Modifier.fillMaxSize().background(Color(0xF51B1713)), contentAlignment = Alignment.Center) {
        Column(
            Modifier.background(Color(0xFF332D26), RoundedCornerShape(12.dp)).border(1.dp, Color(0xFF4A4138), RoundedCornerShape(12.dp))
                .padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text("Staff PIN", fontSize = 32.sp, fontFamily = Headline, color = Cream)
            Text("●".repeat(typed.length).ifEmpty { " " }, fontSize = 28.sp, color = Accent, letterSpacing = 8.sp)
            Text(if (wrong) "That PIN isn’t right" else " ", fontSize = 17.sp, color = Color(0xFFF2A08F))
            listOf(listOf("1", "2", "3"), listOf("4", "5", "6"), listOf("7", "8", "9"), listOf("⌫", "0", "OK")).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    row.forEach { key ->
                        TvButton(key, {
                            wrong = false
                            when (key) {
                                "⌫" -> typed = typed.dropLast(1)
                                "OK" -> if (WebKioskRules.pinMatches(typed, pin)) onRight() else { wrong = true; typed = "" }
                                else -> if (typed.length < 8) typed += key
                            }
                        }, Modifier.width(96.dp), primary = key == "OK")
                    }
                }
            }
            TvButton("Cancel", onCancel, small = true)
        }
    }
}
