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
 * "Escolher foto" de outro app (GET_CONTENT / PICK): a MainActivity é
 * singleTask (outra tarefa) e não devolve resultado a quem chamou. Esta,
 * transparente e na tarefa de quem chamou, guarda o pedido, abre o app no
 * modo escolha e devolve o que a pessoa escolher (ou o cancelamento).
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
    // Voltou para cá sem escolher (trocou de app pelos recentes): cancelado.
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

  /** Pedido em aberto (JSON), ou vazio. */
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

  /** Devolve os arquivos (com permissão de leitura) a quem pediu. */
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
