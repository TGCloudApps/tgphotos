package com.tgcloud.tgphotos

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONArray

class MainActivity : TauriActivity() {
  // Insets in CSS px (dp): top, right, bottom, left, keyboard.
  @Volatile private var insetsJson = """{"top":0,"right":0,"bottom":0,"left":0,"ime":0}"""
  private var webView: WebView? = null
  private var bridge: AndroidBridge? = null
  /** Items received through "Share" waiting for the UI to pick them up. */
  private val shared = mutableListOf<String>()
  var askedNotifications = false

  // System confirmation requests (MediaStore: trash, move, rename).
  private val senders = mutableMapOf<Int, (Boolean) -> Unit>()
  private var senderSeq = 7100

  /** Shows the system confirmation request and reports whether the user accepted. */
  fun askSystem(sender: android.content.IntentSender, done: (Boolean) -> Unit) {
    val code = senderSeq++
    senders[code] = done
    try {
      @Suppress("DEPRECATION")
      startIntentSenderForResult(sender, code, null, 0, 0, 0)
    } catch (e: Exception) {
      senders.remove(code)
      done(false)
    }
  }

  @Deprecated("Deprecated in Java")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    @Suppress("DEPRECATION")
    super.onActivityResult(requestCode, resultCode, data)
    senders.remove(requestCode)?.invoke(resultCode == RESULT_OK)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    installSplashScreen()
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    if (savedInstanceState == null) receive(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    receive(intent)
  }

  /** "Share → TGPhotos" from another app: stores it and notifies the page. */
  private fun receive(intent: Intent?) {
    // Another app asked to pick a photo: the UI opens pick mode.
    if (intent?.action == PickBroker.ACTION) {
      webView?.post { webView?.evaluateJavascript("window.dispatchEvent(new Event('tg-pick'))", null) }
      return
    }
    val uris = mutableListOf<Uri>()
    when (intent?.action) {
      Intent.ACTION_SEND -> streamOf(intent)?.let { uris.add(it) }
      Intent.ACTION_SEND_MULTIPLE -> streamsOf(intent)?.let { uris.addAll(it) }
    }
    if (uris.isEmpty()) return
    val b = bridge
    synchronized(shared) {
      for (u in uris) {
        val item = b?.describe(u, "") ?: org.json.JSONObject().put("uri", u.toString()).put("name", u.lastPathSegment ?: "arquivo").put("size", 0).put("mime", contentResolver.getType(u) ?: "").put("path", "")
        shared.add(item.toString())
      }
    }
    webView?.post { webView?.evaluateJavascript("window.dispatchEvent(new Event('tg-shared'))", null) }
  }

  @Suppress("DEPRECATION")
  private fun streamOf(intent: Intent): Uri? =
    if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
    else intent.getParcelableExtra(Intent.EXTRA_STREAM)

  @Suppress("DEPRECATION")
  private fun streamsOf(intent: Intent): List<Uri>? =
    if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
    else intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)

  fun takeShared(): String = synchronized(shared) {
    val out = JSONArray()
    for (s in shared) out.put(org.json.JSONObject(s))
    shared.clear()
    out.toString()
  }

  /**
   * With targetSdk 35+ the app is always edge-to-edge and the Android WebView does not
   * fill env(safe-area-inset-*). The system and keyboard insets go to
   * the page through a bridge (`TGInsets.get()`) and through a `tg-insets` event.
   */
  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    webView.addJavascriptInterface(object {
      @JavascriptInterface fun get(): String = insetsJson
    }, "TGInsets")
    val b = AndroidBridge(this, webView)
    bridge = b
    webView.addJavascriptInterface(b, "TGAndroid")

    // New photo or video on the device: notifies the page (automatic backup), grouping bursts.
    val handler = android.os.Handler(mainLooper)
    val notify = Runnable { webView.evaluateJavascript("window.dispatchEvent(new Event('tg-media-changed'))", null) }
    val observer = object : android.database.ContentObserver(handler) {
      override fun onChange(selfChange: Boolean) {
        handler.removeCallbacks(notify)
        handler.postDelayed(notify, 4000)
      }
    }
    for (u in listOf(android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI, android.provider.MediaStore.Video.Media.EXTERNAL_CONTENT_URI)) {
      contentResolver.registerContentObserver(u, true, observer)
    }

    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      val d = resources.displayMetrics.density
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      insetsJson = """{"top":${bars.top / d},"right":${bars.right / d},"bottom":${bars.bottom / d},"left":${bars.left / d},"ime":${ime.bottom / d}}"""
      view.post {
        webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('tg-insets',{detail:$insetsJson}))", null)
      }
      insets
    }
  }
}
