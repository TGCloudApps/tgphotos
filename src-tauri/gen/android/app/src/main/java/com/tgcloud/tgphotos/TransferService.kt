package com.tgcloud.tgphotos

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * Mantém o processo vivo enquanto há transferências (tela desligada, app em
 * segundo plano) e mostra o progresso. O estado vem do servidor local do Rust
 * (`/status`), então não depende do WebView estar acordado.
 */
class TransferService : Service() {
  companion object {
    private const val CHANNEL = "transfers"
    private const val ID = 1001
    /** Consultas seguidas sem nada rodando antes de desligar. */
    private const val IDLE_POLLS = 3
  }

  @Volatile private var port = 0
  @Volatile private var running = false
  private var wake: PowerManager.WakeLock? = null
  private var wifi: WifiManager.WifiLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    port = intent?.getIntExtra("port", port) ?: port
    val notification = build("Preparando transferências…", "", 0, 0)
    if (Build.VERSION.SDK_INT >= 29) {
      startForeground(ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(ID, notification)
    }
    if (!running) {
      running = true
      acquireLocks()
      thread(name = "tgphotos-transfers") { loop() }
    }
    return START_NOT_STICKY
  }

  private fun acquireLocks() {
    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
    wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "tgphotos:transfers").apply { acquire(6 * 60 * 60 * 1000L) }
    val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    @Suppress("DEPRECATION")
    wifi = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "tgphotos:transfers").apply { acquire() }
  }

  private fun loop() {
    var idle = 0
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    while (running) {
      try {
        val conn = URL("http://127.0.0.1:$port/status").openConnection() as HttpURLConnection
        conn.connectTimeout = 2000
        conn.readTimeout = 2000
        val body = conn.inputStream.bufferedReader().use { it.readText() }
        val s = JSONObject(body)
        val active = s.optInt("active")
        val queued = s.optInt("queued")
        if (active + queued == 0) idle++ else idle = 0
        if (idle >= IDLE_POLLS) break
        val done = s.optLong("done")
        val total = s.optLong("total")
        val title = s.optString("label").ifEmpty { "Transferências na fila" }
        val text = buildString {
          if (total > 0) append("${fmt(done)} de ${fmt(total)}")
          if (queued > 0) {
            if (isNotEmpty()) append(" · ")
            append("$queued na fila")
          }
        }
        val pct = if (total > 0) ((done * 1000) / total).toInt() else 0
        nm.notify(ID, build(title, text, pct, if (total > 0) 1000 else 0))
      } catch (_: Exception) {
        // App ainda subindo o servidor, ou processo encerrando.
        idle++
        if (idle > IDLE_POLLS * 5) break
      }
      Thread.sleep(1000)
    }
    stopSelf()
  }

  private fun fmt(b: Long): String {
    val units = arrayOf("B", "KB", "MB", "GB", "TB")
    var v = b.toDouble()
    var i = 0
    while (v >= 1024 && i < units.size - 1) {
      v /= 1024
      i++
    }
    return if (i == 0) "$b B" else String.format("%.1f %s", v, units[i])
  }

  private fun build(title: String, text: String, progress: Int, max: Int): Notification {
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
      nm.createNotificationChannel(NotificationChannel(CHANNEL, "Transferências", NotificationManager.IMPORTANCE_LOW))
    }
    val open = PendingIntent.getActivity(
      this, 0,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )
    return NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentTitle(title)
      .setContentText(text)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setContentIntent(open)
      .setProgress(max, progress, max == 0)
      .build()
  }

  override fun onDestroy() {
    running = false
    wake?.let { if (it.isHeld) it.release() }
    wifi?.let { if (it.isHeld) it.release() }
    super.onDestroy()
  }
}
