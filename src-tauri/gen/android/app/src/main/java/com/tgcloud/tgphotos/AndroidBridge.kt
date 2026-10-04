package com.tgcloud.tgphotos

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import kotlin.concurrent.thread

/**
 * Ponte `window.TGAndroid` para o que o WebView não alcança: seletores do
 * sistema com permissão persistente (SAF), pasta de downloads, abrir e
 * compartilhar arquivos, e o serviço de transferências.
 *
 * Chamadas assíncronas recebem um `req` e respondem por `window.__tgReply(req, json)`.
 */
class AndroidBridge(private val activity: MainActivity, private val webView: WebView) {
  private val resolver get() = activity.contentResolver

  private fun reply(req: Int, json: String?) {
    val payload = JSONObject.quote(json ?: "null")
    activity.runOnUiThread {
      webView.evaluateJavascript("window.__tgReply && window.__tgReply($req, $payload)", null)
    }
  }

  private fun persist(uri: Uri, write: Boolean) {
    val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or (if (write) Intent.FLAG_GRANT_WRITE_URI_PERMISSION else 0)
    try {
      resolver.takePersistableUriPermission(uri, flags)
    } catch (_: SecurityException) {
      // Provedor não oferece permissão persistente: vale enquanto o app viver.
    }
  }

  /** Nome, tamanho e tipo de um documento. */
  fun describe(uri: Uri, path: String): JSONObject {
    var name = uri.lastPathSegment ?: "arquivo"
    var size = 0L
    resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
      if (c.moveToFirst()) {
        c.getString(0)?.let { name = it }
        if (!c.isNull(1)) size = c.getLong(1)
      }
    }
    return JSONObject()
      .put("uri", uri.toString())
      .put("name", name)
      .put("size", size)
      .put("mime", resolver.getType(uri) ?: "")
      .put("path", path)
  }

  @JavascriptInterface
  fun pickFiles(req: Int) = openDocuments(req, null)

  /** Só fotos e vídeos (o seletor do sistema já filtra). */
  @JavascriptInterface
  fun pickMedia(req: Int) = openDocuments(req, arrayOf("image/*", "video/*"))

  private fun openDocuments(req: Int, mimes: Array<String>?) {
    activity.runOnUiThread {
      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = "*/*"
        if (mimes != null) putExtra(Intent.EXTRA_MIME_TYPES, mimes)
        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
      }
      activity.launchActivityForResult(intent) { result ->
        val data = result?.data
        thread {
          val uris = mutableListOf<Uri>()
          data?.clipData?.let { clip -> for (i in 0 until clip.itemCount) uris.add(clip.getItemAt(i).uri) }
          if (uris.isEmpty()) data?.data?.let { uris.add(it) }
          val out = JSONArray()
          for (u in uris) {
            persist(u, false)
            out.put(describe(u, ""))
          }
          reply(req, out.toString())
        }
      }
    }
  }

  /** Pasta inteira: devolve todos os arquivos com o caminho relativo (incluindo a própria pasta). */
  @JavascriptInterface
  fun pickFolder(req: Int) {
    activity.runOnUiThread {
      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
      }
      activity.launchActivityForResult(intent) { result ->
        val tree = result?.data?.data
        thread {
          if (tree == null) return@thread reply(req, "[]")
          persist(tree, false)
          val out = JSONArray()
          val rootId = DocumentsContract.getTreeDocumentId(tree)
          val rootName = nameOf(tree, rootId) ?: "Pasta"
          walk(tree, rootId, rootName, out)
          reply(req, out.toString())
        }
      }
    }
  }

  private fun nameOf(tree: Uri, docId: String): String? {
    val uri = DocumentsContract.buildDocumentUriUsingTree(tree, docId)
    resolver.query(uri, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { c ->
      if (c.moveToFirst()) return c.getString(0)
    }
    return null
  }

  private fun walk(tree: Uri, docId: String, path: String, out: JSONArray) {
    val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId)
    val cols = arrayOf(
      DocumentsContract.Document.COLUMN_DOCUMENT_ID,
      DocumentsContract.Document.COLUMN_DISPLAY_NAME,
      DocumentsContract.Document.COLUMN_MIME_TYPE,
      DocumentsContract.Document.COLUMN_SIZE,
    )
    resolver.query(children, cols, null, null, null)?.use { c ->
      while (c.moveToNext()) {
        val id = c.getString(0)
        val name = c.getString(1) ?: continue
        val mime = c.getString(2) ?: ""
        if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
          walk(tree, id, "$path/$name", out)
        } else {
          out.put(
            JSONObject()
              .put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, id).toString())
              .put("name", name)
              .put("size", if (c.isNull(3)) 0 else c.getLong(3))
              .put("mime", mime)
              .put("path", path)
          )
        }
      }
    }
  }

  /** Pasta de downloads, escolhida uma vez (permissão de escrita persistente). */
  @JavascriptInterface
  fun pickDownloadTree(req: Int) {
    activity.runOnUiThread {
      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
        // Abre em Download: o Android não aceita a raiz dela, mas criar
        // "Download/TGPhotos" fica a um toque.
        if (Build.VERSION.SDK_INT >= 26) {
          putExtra(
            DocumentsContract.EXTRA_INITIAL_URI,
            DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", "primary:Download")
          )
        }
        addFlags(
          Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
        )
      }
      activity.launchActivityForResult(intent) { result ->
        val tree = result?.data?.data
        thread {
          if (tree == null) return@thread reply(req, "null")
          persist(tree, true)
          val name = nameOf(tree, DocumentsContract.getTreeDocumentId(tree)) ?: "Downloads"
          reply(req, JSONObject().put("uri", tree.toString()).put("name", name).toString())
        }
      }
    }
  }

  @JavascriptInterface
  fun treeValid(uri: String): Boolean =
    resolver.persistedUriPermissions.any { it.uri.toString() == uri && it.isWritePermission }

  /** Cria (ou acha) as pastas de `dir` dentro da árvore e um documento novo para `name`. */
  @JavascriptInterface
  fun createDocument(tree: String, dir: String, name: String, mime: String): String {
    return try {
      val treeUri = Uri.parse(tree)
      var parent = DocumentsContract.buildDocumentUriUsingTree(treeUri, DocumentsContract.getTreeDocumentId(treeUri))
      for (seg in dir.split('/').filter { it.isNotEmpty() }) {
        parent = findChild(treeUri, parent, seg)
          ?: DocumentsContract.createDocument(resolver, parent, DocumentsContract.Document.MIME_TYPE_DIR, seg)
          ?: return JSONObject().put("error", "não deu para criar a pasta $seg").toString()
      }
      val doc = DocumentsContract.createDocument(resolver, parent, mime.ifEmpty { "application/octet-stream" }, name)
        ?: return JSONObject().put("error", "não deu para criar $name").toString()
      JSONObject().put("uri", doc.toString()).toString()
    } catch (e: Exception) {
      JSONObject().put("error", e.message ?: e.toString()).toString()
    }
  }

  private fun findChild(tree: Uri, parent: Uri, name: String): Uri? {
    val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getDocumentId(parent))
    val cols = arrayOf(
      DocumentsContract.Document.COLUMN_DOCUMENT_ID,
      DocumentsContract.Document.COLUMN_DISPLAY_NAME,
      DocumentsContract.Document.COLUMN_MIME_TYPE,
    )
    resolver.query(children, cols, null, null, null)?.use { c ->
      while (c.moveToNext()) {
        if (c.getString(1) == name && c.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR) {
          return DocumentsContract.buildDocumentUriUsingTree(tree, c.getString(0))
        }
      }
    }
    return null
  }

  @JavascriptInterface
  fun openUri(uri: String, mime: String): Boolean {
    val intent = Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(Uri.parse(uri), mime.ifEmpty { "*/*" })
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    return try {
      activity.startActivity(intent)
      true
    } catch (_: ActivityNotFoundException) {
      false
    }
  }

  /** Compartilha um arquivo do cache do app (preparado pelo Rust). */
  @JavascriptInterface
  fun shareFile(path: String, mime: String, name: String): Boolean {
    return try {
      val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", File(path))
      val send = Intent(Intent.ACTION_SEND).apply {
        type = mime.ifEmpty { "application/octet-stream" }
        putExtra(Intent.EXTRA_STREAM, uri)
        putExtra(Intent.EXTRA_TITLE, name)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      val chooser = Intent.createChooser(send, name).apply {
        // O próprio TGPhotos não aparece como destino.
        putExtra(Intent.EXTRA_EXCLUDE_COMPONENTS, arrayOf(android.content.ComponentName(activity, MainActivity::class.java)))
      }
      startSafely(chooser)
      true
    } catch (e: Exception) {
      false
    }
  }

  /** Compartilha uma mídia do aparelho direto pela URI do MediaStore (sem cópia). */
  @JavascriptInterface
  fun shareUri(uri: String, mime: String): Boolean {
    return try {
      val u = Uri.parse(uri.substringBefore('?'))
      val send = Intent(Intent.ACTION_SEND).apply {
        type = mime.ifEmpty { "*/*" }
        putExtra(Intent.EXTRA_STREAM, u)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      val chooser = Intent.createChooser(send, null).apply {
        putExtra(Intent.EXTRA_EXCLUDE_COMPONENTS, arrayOf(android.content.ComponentName(activity, MainActivity::class.java)))
      }
      startSafely(chooser)
      true
    } catch (e: Exception) {
      false
    }
  }

  /** Liga o serviço em primeiro plano (idempotente). Ele se desliga sozinho sem transferências. */
  @JavascriptInterface
  fun startTransfers(port: Int) {
    activity.runOnUiThread {
      val start = {
        val intent = Intent(activity, TransferService::class.java).putExtra("port", port)
        ContextCompat.startForegroundService(activity, intent)
      }
      if (Build.VERSION.SDK_INT >= 33 &&
        ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
        !activity.askedNotifications
      ) {
        activity.askedNotifications = true
        // Sem a permissão o serviço roda igual; só a notificação não aparece.
        activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS)) { start() }
      } else {
        start()
      }
    }
  }

  /** Itens recebidos por "Compartilhar → TGPhotos" ainda não tratados. */
  @JavascriptInterface
  fun takeShared(): String = activity.takeShared()

  // ---- backup automático (MediaStore) ------------------------------------------------

  private fun granted(p: String) = ContextCompat.checkSelfPermission(activity, p) == PackageManager.PERMISSION_GRANTED

  private fun mediaPermissions(): Array<String> = when {
    Build.VERSION.SDK_INT >= 34 -> arrayOf(
      Manifest.permission.READ_MEDIA_IMAGES,
      Manifest.permission.READ_MEDIA_VIDEO,
      Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED,
      Manifest.permission.ACCESS_MEDIA_LOCATION,
    )
    Build.VERSION.SDK_INT >= 33 -> arrayOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO, Manifest.permission.ACCESS_MEDIA_LOCATION)
    Build.VERSION.SDK_INT >= 29 -> arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.ACCESS_MEDIA_LOCATION)
    else -> arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
  }

  /** Acesso às mídias: total, só as escolhidas (Android 14+) ou nenhum; e se o GPS vem junto. */
  private fun accessJson(): String {
    val full = if (Build.VERSION.SDK_INT >= 33) granted(Manifest.permission.READ_MEDIA_IMAGES) && granted(Manifest.permission.READ_MEDIA_VIDEO)
      else granted(Manifest.permission.READ_EXTERNAL_STORAGE)
    val partial = !full && Build.VERSION.SDK_INT >= 34 && granted(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
    val location = Build.VERSION.SDK_INT < 29 || granted(Manifest.permission.ACCESS_MEDIA_LOCATION)
    return JSONObject().put("full", full).put("partial", partial).put("location", location).toString()
  }

  @JavascriptInterface
  fun mediaAccess(): String = accessJson()

  @JavascriptInterface
  fun requestMedia(req: Int) {
    activity.runOnUiThread {
      activity.requestPermissions(mediaPermissions()) { reply(req, accessJson()) }
    }
  }

  private val collections: List<Uri>
    get() = listOf(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, MediaStore.Video.Media.EXTERNAL_CONTENT_URI)

  /** Pasta relativa de uma linha do MediaStore ("DCIM/Camera"). */
  @Suppress("DEPRECATION")
  private fun folderOf(c: android.database.Cursor): String {
    if (Build.VERSION.SDK_INT >= 29) {
      val i = c.getColumnIndex(MediaStore.MediaColumns.RELATIVE_PATH)
      return (if (i >= 0) c.getString(i) else null)?.trim('/') ?: ""
    }
    val i = c.getColumnIndex(MediaStore.MediaColumns.DATA)
    val data = (if (i >= 0) c.getString(i) else null) ?: return ""
    val root = android.os.Environment.getExternalStorageDirectory().absolutePath
    return File(data).parent?.removePrefix(root)?.trim('/') ?: ""
  }

  @Suppress("DEPRECATION")
  private fun projection(col: Uri? = null): Array<String> = listOfNotNull(
    MediaStore.MediaColumns._ID,
    MediaStore.MediaColumns.DISPLAY_NAME,
    MediaStore.MediaColumns.SIZE,
    MediaStore.MediaColumns.MIME_TYPE,
    MediaStore.MediaColumns.DATE_MODIFIED,
    if (Build.VERSION.SDK_INT >= 29) MediaStore.MediaColumns.RELATIVE_PATH else MediaStore.MediaColumns.DATA,
    "datetaken",
    // Duração só existe na tabela de vídeos antes do Android 10.
    if (col == MediaStore.Video.Media.EXTERNAL_CONTENT_URI) "duration" else null,
  ).toTypedArray()

  private fun longOf(c: android.database.Cursor, column: String): Long {
    val i = c.getColumnIndex(column)
    return if (i >= 0 && !c.isNull(i)) c.getLong(i) else 0L
  }

  /** Pastas do aparelho com fotos/vídeos: [{path, name, count, cover}], as maiores primeiro. */
  @JavascriptInterface
  fun mediaFolders(): String {
    data class F(var count: Int, var cover: String, var newest: Long)
    val folders = linkedMapOf<String, F>()
    for (col in collections) {
      try {
        resolver.query(col, projection(), null, null, null)?.use { c ->
          while (c.moveToNext()) {
            val path = folderOf(c)
            val id = c.getLong(0)
            val modified = c.getLong(4)
            val f = folders.getOrPut(path) { F(0, "", 0) }
            f.count++
            if (modified >= f.newest) {
              f.newest = modified
              f.cover = android.content.ContentUris.withAppendedId(col, id).toString()
            }
          }
        }
      } catch (_: SecurityException) {
        // Sem permissão: lista vazia.
      }
    }
    val out = JSONArray()
    for ((path, f) in folders.entries.sortedByDescending { it.value.count }) {
      out.put(JSONObject().put("path", path).put("name", path.substringAfterLast('/').ifEmpty { "Raiz" }).put("count", f.count).put("cover", f.cover))
    }
    return out.toString()
  }

  /** Mídias das pastas pedidas (caminhos relativos em JSON). */
  @JavascriptInterface
  fun mediaScan(foldersJson: String): String {
    val wanted = JSONArray(foldersJson).let { a -> (0 until a.length()).map { a.getString(it).trim('/') }.toSet() }
    val original = Build.VERSION.SDK_INT >= 29 && granted(Manifest.permission.ACCESS_MEDIA_LOCATION)
    val out = JSONArray()
    for (col in collections) {
      try {
        resolver.query(col, projection(col), null, null, null)?.use { c ->
          while (c.moveToNext()) {
            val path = folderOf(c)
            if (path !in wanted) continue
            var uri = android.content.ContentUris.withAppendedId(col, c.getLong(0))
            // Com a permissão de localização, o original mantém o GPS do EXIF.
            if (original) uri = MediaStore.setRequireOriginal(uri)
            out.put(
              JSONObject()
                .put("uri", uri.toString())
                .put("name", c.getString(1) ?: "midia")
                .put("size", c.getLong(2))
                .put("mime", c.getString(3) ?: "")
                .put("modified", c.getLong(4))
                .put("path", path)
                .put("taken", longOf(c, "datetaken"))
                .put("duration", longOf(c, "duration")),
            )
          }
        }
      } catch (_: SecurityException) {
      }
    }
    return out.toString()
  }

  private val thumbs = java.util.concurrent.Executors.newFixedThreadPool(4)

  /**
   * Miniatura do sistema (MediaStore) como `data:` JPEG, para as pastas do
   * aparelho: o WebView não abre `content://`.
   */
  @JavascriptInterface
  fun deviceThumb(req: Int, uri: String, size: Int) {
    thumbs.execute {
      val out = try {
        val u = Uri.parse(uri.substringBefore('?'))
        val bmp = if (Build.VERSION.SDK_INT >= 29) {
          resolver.loadThumbnail(u, android.util.Size(size, size), null)
        } else {
          @Suppress("DEPRECATION")
          val id = android.content.ContentUris.parseId(u)
          @Suppress("DEPRECATION")
          if (u.toString().contains("/video/")) MediaStore.Video.Thumbnails.getThumbnail(resolver, id, MediaStore.Video.Thumbnails.MINI_KIND, null)
          else MediaStore.Images.Thumbnails.getThumbnail(resolver, id, MediaStore.Images.Thumbnails.MINI_KIND, null)
        }
        val bytes = java.io.ByteArrayOutputStream()
        bmp.compress(android.graphics.Bitmap.CompressFormat.JPEG, 80, bytes)
        "data:image/jpeg;base64," + android.util.Base64.encodeToString(bytes.toByteArray(), android.util.Base64.NO_WRAP)
      } catch (_: Exception) {
        ""
      }
      reply(req, JSONObject.quote(out))
    }
  }

  /**
   * Abre outra tela/app na thread de interface, sem derrubar o app se o
   * sistema recusar (permissão, nenhum app): avisa a página com `tg-intent-failed`.
   */
  private fun startSafely(intent: Intent) {
    activity.runOnUiThread {
      try {
        activity.startActivity(intent)
      } catch (e: Exception) {
        val msg = JSONObject.quote(e.message ?: "não deu para abrir")
        webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('tg-intent-failed',{detail:$msg}))", null)
      }
    }
  }

  // ---- gerenciar fotos do aparelho (galeria) -------------------------------------------

  private fun urisOf(json: String): List<Uri> =
    JSONArray(json).let { a -> (0 until a.length()).map { Uri.parse(a.getString(it).substringBefore('?')) } }

  private fun done(req: Int, ok: Boolean, error: String? = null) =
    reply(req, JSONObject().put("ok", ok).apply { if (error != null) put("error", error) }.toString())

  // ---- lixeira do aparelho (unificada com a do vault) ----------------------------------
  //
  // Android 11+: lixeira do sistema (o arquivo fica na pasta, escondido, com o
  // mesmo endereço; o sistema apaga sozinho em 30 dias). Antes disso não há
  // lixeira: o app guarda uma cópia na pasta dele e devolve ao restaurar.
  // Com "Gerenciamento de mídia" (Android 12+), o sistema não pede confirmação.

  private val systemTrash get() = Build.VERSION.SDK_INT >= 30

  /** Android < 11: escrita no armazenamento (apagar e devolver fotos de outros apps). */
  private fun withWrite(req: Int, then: () -> Unit) {
    if (Build.VERSION.SDK_INT >= 30 || granted(Manifest.permission.WRITE_EXTERNAL_STORAGE)) return then()
    activity.runOnUiThread {
      activity.requestPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE)) {
        if (granted(Manifest.permission.WRITE_EXTERNAL_STORAGE)) then() else done(req, false, "sem permissão para apagar fotos do aparelho")
      }
    }
  }

  private fun stashDir(): File = File(activity.getExternalFilesDir(null) ?: activity.filesDir, "lixeira").apply { mkdirs() }

  private fun copy(from: java.io.InputStream, to: java.io.OutputStream) = from.use { i -> to.use { o -> i.copyTo(o, 1 shl 20) } }

  /**
   * Para a lixeira. Responde `{ok, items: [{uri, stash, folder}]}`: `stash` é
   * a cópia guardada pelo app (Android < 11, com a pasta de origem); no 11+
   * vem vazio (lixeira do sistema).
   */
  @JavascriptInterface
  fun deviceTrash(req: Int, urisJson: String) {
    val uris = urisOf(urisJson)
    if (uris.isEmpty()) return done(req, false)
    if (systemTrash) {
      activity.runOnUiThread {
        try {
          val pi = MediaStore.createTrashRequest(resolver, uris, true)
          activity.askSystem(pi.intentSender) { ok ->
            val items = JSONArray()
            if (ok) uris.forEach { items.put(JSONObject().put("uri", it.toString())) }
            reply(req, JSONObject().put("ok", ok).put("items", items).toString())
          }
        } catch (e: Exception) {
          done(req, false, e.message ?: "o sistema recusou")
        }
      }
      return
    }
    withWrite(req) {
      thread {
        val items = JSONArray()
        var error: String? = null
        for (u in uris) {
          val stash = File(stashDir(), "${android.content.ContentUris.parseId(u)}-${System.currentTimeMillis()}")
          try {
            // Pasta de origem: para onde a cópia volta ao restaurar.
            val folder = resolver.query(u, projection(), null, null, null)?.use { c -> if (c.moveToFirst()) folderOf(c) else "" } ?: ""
            copy(resolver.openInputStream(u) ?: throw java.io.IOException("não deu para ler"), stash.outputStream())
            if (resolver.delete(u, null, null) < 1) throw java.io.IOException("o sistema não apagou")
            items.put(JSONObject().put("uri", u.toString()).put("stash", stash.absolutePath).put("folder", folder))
          } catch (e: Exception) {
            stash.delete()
            error = e.message
          }
        }
        reply(req, JSONObject().put("ok", items.length() > 0).put("items", items).apply { if (error != null) put("error", error) }.toString())
      }
    }
  }

  /**
   * Sai da lixeira: `[{uri, stash, folder, name, mime, taken}]`. Responde
   * `{ok, items: [{uri, new}]}` — `new` é o endereço novo de quem voltou de
   * uma cópia guardada (Android < 11); da lixeira do sistema o endereço não muda.
   */
  @JavascriptInterface
  fun deviceRestore(req: Int, json: String) {
    val list = JSONArray(json).let { a -> (0 until a.length()).map { a.getJSONObject(it) } }
    val system = list.filter { it.optString("stash").isEmpty() }.map { Uri.parse(it.getString("uri").substringBefore('?')) }
    val stashed = list.filter { it.optString("stash").isNotEmpty() }
    val items = JSONArray()
    val finish = { error: String? ->
      reply(req, JSONObject().put("ok", items.length() > 0).put("items", items).apply { if (error != null) put("error", error) }.toString())
    }
    val fromStash = {
      if (stashed.isEmpty()) finish(null)
      else withWrite(req) {
        thread {
          var error: String? = null
          for (o in stashed) {
            try {
              val new = unstash(o)
              items.put(JSONObject().put("uri", o.getString("uri")).put("new", new.toString()))
            } catch (e: Exception) {
              error = e.message
            }
          }
          finish(error)
        }
      }
    }
    if (system.isNotEmpty() && systemTrash) {
      activity.runOnUiThread {
        try {
          val pi = MediaStore.createTrashRequest(resolver, system, false)
          activity.askSystem(pi.intentSender) { ok ->
            if (ok) system.forEach { items.put(JSONObject().put("uri", it.toString())) }
            fromStash()
          }
        } catch (e: Exception) {
          done(req, false, e.message ?: "o sistema recusou")
        }
      }
    } else {
      fromStash()
    }
  }

  /** Devolve uma cópia guardada para a pasta de origem; devolve o endereço novo. */
  @Suppress("DEPRECATION")
  private fun unstash(o: JSONObject): Uri {
    val stash = File(o.getString("stash"))
    if (!stash.exists()) throw java.io.IOException("a cópia guardada sumiu")
    val name = o.optString("name").ifEmpty { stash.name }
    val mime = o.optString("mime").ifEmpty { "image/jpeg" }
    val folder = o.optString("folder").trim('/').ifEmpty { "DCIM/Camera" }
    val video = mime.startsWith("video/")
    val col = if (video) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI
    val uri = if (Build.VERSION.SDK_INT >= 29) {
      val values = android.content.ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, name)
        put(MediaStore.MediaColumns.MIME_TYPE, mime)
        put(MediaStore.MediaColumns.RELATIVE_PATH, "$folder/")
        put(MediaStore.MediaColumns.IS_PENDING, 1)
        val taken = o.optLong("taken")
        if (taken > 0) put("datetaken", taken)
      }
      val u = resolver.insert(col, values) ?: throw java.io.IOException("o sistema não aceitou o arquivo")
      copy(stash.inputStream(), resolver.openOutputStream(u) ?: throw java.io.IOException("não deu para gravar"))
      resolver.update(u, android.content.ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
      u
    } else {
      val dir = File(android.os.Environment.getExternalStorageDirectory(), folder).apply { mkdirs() }
      var file = File(dir, name)
      var n = 1
      while (file.exists()) file = File(dir, "${name.substringBeforeLast('.')} (${n++}).${name.substringAfterLast('.', "jpg")}")
      copy(stash.inputStream(), file.outputStream())
      val values = android.content.ContentValues().apply {
        put(MediaStore.MediaColumns.DATA, file.absolutePath)
        put(MediaStore.MediaColumns.DISPLAY_NAME, file.name)
        put(MediaStore.MediaColumns.MIME_TYPE, mime)
        val taken = o.optLong("taken")
        if (taken > 0) put("datetaken", taken)
      }
      resolver.insert(col, values) ?: throw java.io.IOException("o sistema não aceitou o arquivo")
    }
    stash.delete()
    return uri
  }

  /**
   * Apaga de vez: `[{uri, stash}]`. Cópia guardada (Android < 11) é só um
   * arquivo do app; o resto passa pelo sistema (uma confirmação para o lote).
   * Serve para "esvaziar a lixeira" e para "liberar espaço".
   */
  @JavascriptInterface
  fun deviceDelete(req: Int, json: String) {
    val list = JSONArray(json).let { a -> (0 until a.length()).map { a.getJSONObject(it) } }
    list.filter { it.optString("stash").isNotEmpty() }.forEach { File(it.getString("stash")).delete() }
    val uris = list.filter { it.optString("stash").isEmpty() }.map { Uri.parse(it.getString("uri").substringBefore('?')) }
    if (uris.isEmpty()) return done(req, true)
    if (systemTrash) {
      activity.runOnUiThread {
        try {
          val pi = MediaStore.createDeleteRequest(resolver, uris)
          activity.askSystem(pi.intentSender) { ok -> done(req, ok) }
        } catch (e: Exception) {
          done(req, false, e.message ?: "o sistema recusou")
        }
      }
      return
    }
    withWrite(req) {
      thread {
        var n = 0
        for (u in uris) n += try { resolver.delete(u, null, null) } catch (_: Exception) { 0 }
        done(req, n > 0, if (n < uris.size) "nem todos puderam ser apagados" else null)
      }
    }
  }

  /**
   * Situação de cada item `[{uri, stash}]`: 0 = não existe mais, 1 = no
   * aparelho, 2 = na lixeira (do sistema ou cópia guardada).
   */
  @JavascriptInterface
  fun mediaStates(json: String): String {
    val list = JSONArray(json).let { a -> (0 until a.length()).map { a.getJSONObject(it) } }
    val out = IntArray(list.size)
    // Por coleção, em lotes: milhares de itens sem uma consulta por item.
    val byCol = mutableMapOf<Uri, MutableList<Pair<Int, Long>>>()
    list.forEachIndexed { i, o ->
      val stash = o.optString("stash")
      if (stash.isNotEmpty()) {
        out[i] = if (File(stash).exists()) 2 else 0
        return@forEachIndexed
      }
      val u = Uri.parse(o.getString("uri").substringBefore('?'))
      val id = try { android.content.ContentUris.parseId(u) } catch (_: Exception) { -1L }
      if (id < 0) return@forEachIndexed
      val col = if (u.toString().contains("/video/")) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI
      byCol.getOrPut(col) { mutableListOf() }.add(i to id)
    }
    for ((col, items) in byCol) {
      for (chunk in items.chunked(400)) {
        val ids = chunk.joinToString(",") { it.second.toString() }
        val found = mutableMapOf<Long, Int>()
        try {
          val cursor = if (systemTrash) {
            val args = android.os.Bundle().apply {
              putString(android.content.ContentResolver.QUERY_ARG_SQL_SELECTION, "${MediaStore.MediaColumns._ID} IN ($ids)")
              putInt(MediaStore.QUERY_ARG_MATCH_TRASHED, MediaStore.MATCH_INCLUDE)
            }
            resolver.query(col, arrayOf(MediaStore.MediaColumns._ID, MediaStore.MediaColumns.IS_TRASHED), args, null)
          } else {
            resolver.query(col, arrayOf(MediaStore.MediaColumns._ID), "${MediaStore.MediaColumns._ID} IN ($ids)", null, null)
          }
          cursor?.use { c ->
            while (c.moveToNext()) found[c.getLong(0)] = if (systemTrash && c.getInt(1) == 1) 2 else 1
          }
        } catch (_: Exception) {
          continue
        }
        for ((i, id) in chunk) out[i] = found[id] ?: 0
      }
    }
    return JSONArray(out.toList()).toString()
  }

  /** "Gerenciamento de mídia" (Android 12+): apagar e restaurar sem confirmação. */
  @JavascriptInterface
  fun manageMedia(): String = JSONObject()
    .put("supported", Build.VERSION.SDK_INT >= 31)
    .put("granted", Build.VERSION.SDK_INT >= 31 && MediaStore.canManageMedia(activity))
    .toString()

  @JavascriptInterface
  fun requestManageMedia(req: Int) {
    if (Build.VERSION.SDK_INT < 31) return reply(req, manageMedia())
    activity.runOnUiThread {
      val intent = Intent(android.provider.Settings.ACTION_REQUEST_MANAGE_MEDIA, Uri.parse("package:${activity.packageName}"))
      try {
        activity.launchActivityForResult(intent) { reply(req, manageMedia()) }
      } catch (_: Exception) {
        reply(req, manageMedia())
      }
    }
  }

  /** Com permissão de escrita (Android 11+: uma confirmação para o lote), aplica `values` em cada item. */
  private fun write(req: Int, uris: List<Uri>, values: (Uri) -> android.content.ContentValues) {
    val apply = {
      thread {
        var n = 0
        var error: String? = null
        for (u in uris) {
          try {
            n += resolver.update(u, values(u), null, null)
          } catch (e: Exception) {
            error = e.message
          }
        }
        done(req, n > 0, error)
      }
    }
    if (Build.VERSION.SDK_INT >= 30) {
      activity.runOnUiThread {
        try {
          val pi = MediaStore.createWriteRequest(resolver, uris)
          activity.askSystem(pi.intentSender) { ok -> if (ok) apply() else done(req, false) }
        } catch (e: Exception) {
          done(req, false, e.message ?: "o sistema recusou")
        }
      }
    } else {
      apply()
    }
  }

  /** Move para outra pasta do aparelho ("Pictures/Viagem"). Android 10+. */
  @JavascriptInterface
  fun deviceMove(req: Int, urisJson: String, folder: String) {
    if (Build.VERSION.SDK_INT < 29) return done(req, false, "mover pastas precisa do Android 10 ou mais novo")
    write(req, urisOf(urisJson)) {
      android.content.ContentValues().apply { put(MediaStore.MediaColumns.RELATIVE_PATH, folder.trim('/') + "/") }
    }
  }

  @JavascriptInterface
  fun deviceRename(req: Int, uri: String, name: String) {
    write(req, listOf(Uri.parse(uri.substringBefore('?')))) {
      android.content.ContentValues().apply { put(MediaStore.MediaColumns.DISPLAY_NAME, name) }
    }
  }

  /** Abrir com / editar / definir como (outro app), escolhido pelo sistema. */
  @JavascriptInterface
  fun deviceIntent(uri: String, mime: String, action: String): Boolean {
    val act = when (action) {
      "edit" -> Intent.ACTION_EDIT
      "attach" -> Intent.ACTION_ATTACH_DATA
      else -> Intent.ACTION_VIEW
    }
    val intent = Intent(act).apply {
      setDataAndType(Uri.parse(uri.substringBefore('?')), mime.ifEmpty { "image/*" })
      // Só leitura: o TGPhotos não tem escrita nas fotos da galeria, e repassar
      // uma permissão que não tem derruba o app (SecurityException). Editores
      // salvam uma cópia.
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      if (action == "attach") putExtra("mimeType", mime)
    }
    val chooser = Intent.createChooser(intent, null).apply {
      putExtra(Intent.EXTRA_EXCLUDE_COMPONENTS, arrayOf(android.content.ComponentName(activity, MainActivity::class.java)))
    }
    startSafely(chooser)
    return true
  }

  // ---- downloads na pasta padrão do app (sem escolher pasta) ---------------------------
  //
  // Como o Google Fotos (DCIM/Restored) e o Drive: o arquivo nasce no
  // MediaStore, pendente (outros apps não veem pela metade); o Rust grava pelo
  // endereço e `finishMedia` publica no fim. Android < 10: arquivo comum na
  // pasta, avisado ao sistema no fim.

  private fun canWriteLegacy() = Build.VERSION.SDK_INT >= 29 ||
    ContextCompat.checkSelfPermission(activity, Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED

  /** Cria `dir/name` (dir relativo ao armazenamento: "DCIM/Restored", "Download/TGDrive/Pasta"). Responde `{uri}` ou `{error}`. */
  @JavascriptInterface
  fun createMedia(req: Int, dir: String, name: String, mime: String) {
    val rel = dir.split('/').filter { it.isNotBlank() }.joinToString("/")
    val type = mime.ifEmpty { "application/octet-stream" }
    val fail = { e: Exception -> reply(req, JSONObject().put("error", e.message ?: e.toString()).toString()) }
    if (Build.VERSION.SDK_INT >= 29) {
      thread {
        try {
          val col = when {
            rel == "Download" || rel.startsWith("Download/") -> android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI
            type.startsWith("image/") -> android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI
            type.startsWith("video/") -> android.provider.MediaStore.Video.Media.EXTERNAL_CONTENT_URI
            type.startsWith("audio/") -> android.provider.MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
            else -> android.provider.MediaStore.Files.getContentUri("external")
          }
          val values = android.content.ContentValues().apply {
            put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(android.provider.MediaStore.MediaColumns.MIME_TYPE, type)
            put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, "$rel/")
            put(android.provider.MediaStore.MediaColumns.IS_PENDING, 1)
          }
          val uri = resolver.insert(col, values) ?: throw java.io.IOException("o sistema não aceitou o arquivo")
          reply(req, JSONObject().put("uri", uri.toString()).toString())
        } catch (e: Exception) {
          fail(e)
        }
      }
      return
    }
    val create = {
      thread {
        try {
          @Suppress("DEPRECATION")
          val folder = File(android.os.Environment.getExternalStorageDirectory(), rel).apply { mkdirs() }
          var file = File(folder, name)
          var n = 1
          val base = name.substringBeforeLast('.')
          val ext = name.substringAfterLast('.', "")
          while (file.exists()) file = File(folder, if (ext.isEmpty()) "$base (${n++})" else "$base (${n++}).$ext")
          file.createNewFile()
          reply(req, JSONObject().put("uri", Uri.fromFile(file).toString()).toString())
        } catch (e: Exception) {
          fail(e)
        }
      }
    }
    if (canWriteLegacy()) create()
    else activity.runOnUiThread {
      activity.requestPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE)) {
        if (canWriteLegacy()) create() else reply(req, JSONObject().put("error", "sem permissão para salvar no aparelho").toString())
      }
    }
  }

  /** Download terminado: aparece para a galeria e os outros apps. */
  @JavascriptInterface
  fun finishMedia(uri: String) {
    thread {
      try {
        val u = Uri.parse(uri)
        if (u.scheme == "file") {
          android.media.MediaScannerConnection.scanFile(activity, arrayOf(u.path), null, null)
        } else if (Build.VERSION.SDK_INT >= 29 && u.authority == "media") {
          resolver.update(u, android.content.ContentValues().apply { put(android.provider.MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
        }
      } catch (_: Exception) {
      }
    }
  }
}
