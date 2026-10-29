package com.kiosk.player

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Android tells the app when the TV box has finished starting up; we open the
 * player straight away so screens come back by themselves after a power cut.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        context.startActivity(
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }
}
