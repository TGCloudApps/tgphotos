package com.tgcloud.tgphotos

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import org.json.JSONArray
import org.json.JSONObject
import java.lang.ref.WeakReference

/**
 * "Pick a photo" from another app (GET_CONTENT / PICK): MainActivity is
 * singleTask (another task) and does not return a result to the caller. This one,
 * transparent and in the caller's task, stores the request, opens the app in pick
 * mode and returns what the person picks (or the cancellation).
 */
class PickActivity : Activity() {
  private var shown = false

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    if (savedInstanceState != null) {
      PickBroker.attach(this)
      return
    }
    val types = mutableListOf<String>()
    intent.type?.let { types.add(it) }
    intent.getStringArrayExtra(Intent.EXTRA_MIME_TYPES)?.let { types.addAll(it) }
    val caller = callingPackage?.let { pkg ->
      try {
        packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString()
      } catch (_: Exception) {
        null
      }
    }
    val req = JSONObject()
      .put("multiple", intent.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, false))
      .put("mimes", JSONArray(types))
      .put("caller", caller ?: "")
    PickBroker.begin(this, req.toString())
    startActivity(Intent(this, MainActivity::class.java).setAction(PickBroker.ACTION).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
  }

  override fun onResume() {
    super.onResume()
    // Came back here without picking (switched apps through recents): cancelled.
    if (shown) PickBroker.cancel()
    shown = true
  }
}

object PickBroker {
  const val ACTION = "com.tgcloud.tgphotos.PICK"
  private var activity: WeakReference<Activity>? = null
  @Volatile private var request: String? = null

  fun begin(a: Activity, req: String) {
    activity = WeakReference(a)
    request = req
  }

  fun attach(a: Activity) {
    activity = WeakReference(a)
  }

  /** Open request (JSON), or empty. */
  fun take(): String = request ?: ""

  fun cancel() {
    val a = activity?.get()
    request = null
    activity = null
    a?.runOnUiThread {
      a.setResult(Activity.RESULT_CANCELED)
      a.finish()
    }
  }

  /** Returns the files (with read permission) to the caller. */
  fun deliver(uris: List<Uri>, mime: String) {
    val a = activity?.get() ?: return
    request = null
    activity = null
    a.runOnUiThread {
      val data = Intent().apply {
        if (uris.isNotEmpty()) {
          setDataAndType(uris[0], mime)
          val clip = ClipData.newRawUri("", uris[0])
          for (u in uris.drop(1)) clip.addItem(ClipData.Item(u))
          clipData = clip
        }
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      a.setResult(if (uris.isEmpty()) Activity.RESULT_CANCELED else Activity.RESULT_OK, data)
      a.finish()
    }
  }
}
