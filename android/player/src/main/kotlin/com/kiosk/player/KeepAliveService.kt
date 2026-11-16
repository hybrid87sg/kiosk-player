package com.kiosk.player

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Tells Android "this app is playing media", the way a music app does. When
 * the TV box runs short of memory, Android closes apps in the background
 * first and keeps apps like this one, so the player is much less likely to be
 * closed. It does no work of its own.
 *
 * If Android closes it anyway, it asks to be started again ("sticky"), and on
 * that restart it nudges the [Watchdog] to check the screen soon.
 */
class KeepAliveService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            val manager = getSystemService(NotificationManager::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                manager.createNotificationChannel(
                    NotificationChannel(CHANNEL, "Kiosk Player running", NotificationManager.IMPORTANCE_LOW),
                )
            }
            val notification = NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_launcher_foreground)
                .setContentTitle("Kiosk Player")
                .setContentText("Showing this screen's playlist")
                .setOngoing(true)
                .setSilent(true)
                .build()
            val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK else 0
            ServiceCompat.startForeground(this, 1, notification, type)
        } catch (e: Exception) {
            // Some Android versions refuse this when not started from the screen; the watchdog still works.
            stopSelf()
            return START_NOT_STICKY
        }
        // Started again by Android after it closed the app: check the screen shortly.
        if (intent == null) Watchdog.arm(this, 5_000)
        return START_STICKY
    }

    companion object {
        private const val CHANNEL = "keep-alive"

        /** Called while the player is on screen (Android only allows starting it then). */
        fun start(context: Context) {
            runCatching { ContextCompat.startForegroundService(context, Intent(context, KeepAliveService::class.java)) }
        }
    }
}
