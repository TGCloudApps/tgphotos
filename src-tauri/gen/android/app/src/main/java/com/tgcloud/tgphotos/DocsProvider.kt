package com.tgcloud.tgphotos

import android.content.Context
import android.content.res.AssetFileDescriptor
import android.database.Cursor
import android.database.MatrixCursor
import android.graphics.Point
import android.os.CancellationSignal
import android.os.Handler
import android.os.HandlerThread
import android.os.ParcelFileDescriptor
import android.os.ProxyFileDescriptorCallback
import android.os.storage.StorageManager
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.DocumentsContract.Root
import android.provider.DocumentsProvider
import android.system.ErrnoException
import android.system.OsConstants
import org.json.JSONArray
import java.io.FileNotFoundException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import kotlin.concurrent.thread

/** Onde o servidor local do app está (a interface informa ao abrir um vault). */
object DocsState {
  @Volatile var port = 0
  @Volatile var token = ""
  @Volatile var vault = 0L
  @Volatile var name = ""
  val ready get() = port > 0 && vault != 0L
}

/**
 * O vault aberto como origem no seletor de arquivos do Android (Fotos por
 * mês, Álbuns, Favoritos). Lê pelo servidor local do app: listas em
 * `/docs/list`, bytes em `/f/<id>` (com Range: o outro app lê enquanto chega
 * do Telegram), miniaturas em `/thumb/<id>`. Com o app fechado (processo sem
 * o núcleo), a origem aparece pedindo para abrir o TGPhotos.
 */
class DocsProvider : DocumentsProvider() {
  companion object {
    private val ROOT_COLS = arrayOf(Root.COLUMN_ROOT_ID, Root.COLUMN_FLAGS, Root.COLUMN_TITLE, Root.COLUMN_SUMMARY, Root.COLUMN_DOCUMENT_ID, Root.COLUMN_ICON, Root.COLUMN_MIME_TYPES)
    private val DOC_COLS = arrayOf(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED, Document.COLUMN_FLAGS)
    private const val CHUNK = 1 shl 20

    fun authority(ctx: Context) = "${ctx.packageName}.documents"

    /** O vault abriu/fechou: o seletor relê a origem. */
    fun changed(ctx: Context) {
      ctx.contentResolver.notifyChange(DocumentsContract.buildRootsUri(authority(ctx)), null)
    }
  }

  private data class Doc(val id: String, val name: String, val mime: String, val size: Long, val modified: Long, val thumb: Boolean)

  /** O que já foi listado (nome, tipo e tamanho de quem o seletor pergunta depois). */
  private val known = ConcurrentHashMap<String, Doc>()
  private val io by lazy { Handler(HandlerThread("tg-docs").apply { start() }.looper) }

  override fun onCreate() = true

  private fun base() = "http://127.0.0.1:${DocsState.port}"

  private fun get(path: String, range: LongRange? = null): Pair<ByteArray, Long> {
    val c = URL(base() + path).openConnection() as HttpURLConnection
    c.connectTimeout = 5000
    c.readTimeout = 60000
    if (range != null) c.setRequestProperty("Range", "bytes=${range.first}-${range.last}")
    try {
      if (c.responseCode >= 400) throw FileNotFoundException("HTTP ${c.responseCode}")
      val total = c.getHeaderField("Content-Range")?.substringAfter('/')?.toLongOrNull() ?: c.contentLengthLong
      return c.inputStream.use { it.readBytes() } to total
    } finally {
      c.disconnect()
    }
  }

  private fun list(dir: String): List<Doc> {
    if (!DocsState.ready) return emptyList()
    val (bytes, _) = get("/docs/list?t=${DocsState.token}&dir=${java.net.URLEncoder.encode(dir, "UTF-8")}")
    val arr = JSONArray(String(bytes))
    return (0 until arr.length()).map {
      val o = arr.getJSONObject(it)
      Doc(o.getString("id"), o.getString("name"), o.getString("mime"), o.optLong("size"), o.optLong("modified"), o.optBoolean("thumb"))
    }.onEach { known[it.id] = it }
  }

  private fun row(c: MatrixCursor, d: Doc) {
    val dir = d.mime == Document.MIME_TYPE_DIR
    c.newRow().apply {
      add(Document.COLUMN_DOCUMENT_ID, d.id)
      add(Document.COLUMN_DISPLAY_NAME, d.name)
      add(Document.COLUMN_MIME_TYPE, d.mime)
      add(Document.COLUMN_SIZE, if (dir) null else d.size)
      add(Document.COLUMN_LAST_MODIFIED, if (d.modified > 0) d.modified else null)
      add(Document.COLUMN_FLAGS, if (!dir && d.thumb) Document.FLAG_SUPPORTS_THUMBNAIL else 0)
    }
  }

  override fun queryRoots(projection: Array<out String>?): Cursor {
    val c = MatrixCursor(projection ?: ROOT_COLS)
    c.newRow().apply {
      add(Root.COLUMN_ROOT_ID, "tgphotos")
      add(Root.COLUMN_FLAGS, Root.FLAG_SUPPORTS_IS_CHILD)
      add(Root.COLUMN_TITLE, "TGPhotos")
      add(Root.COLUMN_SUMMARY, if (DocsState.ready) DocsState.name else "Abra o TGPhotos para ver as fotos")
      add(Root.COLUMN_DOCUMENT_ID, "root")
      add(Root.COLUMN_ICON, R.mipmap.ic_launcher)
      add(Root.COLUMN_MIME_TYPES, "image/*\nvideo/*")
    }
    context?.let { c.setNotificationUri(it.contentResolver, DocumentsContract.buildRootsUri(authority(it))) }
    return c
  }

  override fun queryDocument(documentId: String, projection: Array<out String>?): Cursor {
    val c = MatrixCursor(projection ?: DOC_COLS)
    val d = known[documentId] ?: when (documentId) {
      "root" -> Doc("root", DocsState.name.ifEmpty { "TGPhotos" }, Document.MIME_TYPE_DIR, 0, 0, false)
      "photos" -> Doc("photos", "Fotos", Document.MIME_TYPE_DIR, 0, 0, false)
      "albums" -> Doc("albums", "Álbuns", Document.MIME_TYPE_DIR, 0, 0, false)
      "fav" -> Doc("fav", "Favoritos", Document.MIME_TYPE_DIR, 0, 0, false)
      else -> if (documentId.startsWith("f:")) Doc(documentId, documentId, "application/octet-stream", 0, 0, false) else Doc(documentId, documentId.substringAfter(':'), Document.MIME_TYPE_DIR, 0, 0, false)
    }
    row(c, d)
    return c
  }

  override fun queryChildDocuments(parentDocumentId: String, projection: Array<out String>?, sortOrder: String?): Cursor {
    val c = MatrixCursor(projection ?: DOC_COLS)
    if (!DocsState.ready) {
      c.extras = android.os.Bundle().apply { putString(DocumentsContract.EXTRA_INFO, "Abra o TGPhotos (e um vault) para ver as fotos aqui.") }
      return c
    }
    try {
      list(parentDocumentId).forEach { row(c, it) }
    } catch (e: Exception) {
      c.extras = android.os.Bundle().apply { putString(DocumentsContract.EXTRA_ERROR, "Não deu para ler o vault agora.") }
    }
    return c
  }

  override fun isChildDocument(parentDocumentId: String, documentId: String) = true

  override fun openDocument(documentId: String, mode: String, signal: CancellationSignal?): ParcelFileDescriptor {
    if (mode != "r" || !documentId.startsWith("f:") || !DocsState.ready) throw FileNotFoundException(documentId)
    val id = documentId.removePrefix("f:")
    val path = "/f/$id?v=${DocsState.vault}"
    val size = known[documentId]?.size?.takeIf { it > 0 } ?: get(path, 0L..0L).second
    // Android 7: sem leitura sob demanda; baixa inteiro para o cache e abre.
    if (android.os.Build.VERSION.SDK_INT < 26) {
      val f = java.io.File(context!!.cacheDir, "docs/$id").apply { parentFile?.mkdirs() }
      if (f.length() != size) f.writeBytes(get(path).first)
      return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY)
    }
    val sm = context!!.getSystemService(StorageManager::class.java)
    // Lido sob demanda, em blocos de 1 MB (o último fica guardado).
    return sm.openProxyFileDescriptor(ParcelFileDescriptor.MODE_READ_ONLY, object : ProxyFileDescriptorCallback() {
      private var at = -1L
      private var buf = ByteArray(0)
      override fun onGetSize() = size
      override fun onRead(offset: Long, length: Int, data: ByteArray): Int {
        var done = 0
        try {
          while (done < length && offset + done < size) {
            val pos = offset + done
            val block = pos / CHUNK * CHUNK
            if (block != at) {
              buf = get(path, block..minOf(block + CHUNK, size) - 1).first
              at = block
            }
            val from = (pos - block).toInt()
            val n = minOf(length - done, buf.size - from)
            if (n <= 0) break
            System.arraycopy(buf, from, data, done, n)
            done += n
          }
        } catch (e: Exception) {
          throw ErrnoException("read", OsConstants.EIO)
        }
        return done
      }
      override fun onRelease() {
        buf = ByteArray(0)
      }
    }, io)
  }

  override fun openDocumentThumbnail(documentId: String, sizeHint: Point?, signal: CancellationSignal?): AssetFileDescriptor {
    if (!documentId.startsWith("f:") || !DocsState.ready) throw FileNotFoundException(documentId)
    val bytes = get("/thumb/${documentId.removePrefix("f:")}?v=${DocsState.vault}").first
    val pipe = ParcelFileDescriptor.createPipe()
    thread {
      ParcelFileDescriptor.AutoCloseOutputStream(pipe[1]).use { it.write(bytes) }
    }
    return AssetFileDescriptor(pipe[0], 0, AssetFileDescriptor.UNKNOWN_LENGTH)
  }
}
