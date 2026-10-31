package com.kiosk.player

import android.app.Activity
import android.app.AlarmManager
import android.app.PendingIntent
import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PowerManager

/**
 * What the TV does outside its location's working hours.
 *
 * Always: the player shows a black screen. Where allowed, it also puts the
 * device to sleep ("standby"): on an Android TV box with HDMI-CEC switched on,
 * the TV follows it into standby, and many TVs with Android built in sleep
 * themselves. At opening time an alarm wakes the device and opens the player
 * again; on a box, HDMI-CEC "one-touch play" turns the TV back on.
 *
 * Sleeping needs the one-time "Allow Kiosk Player to turn the screen off"
 * permission (Android calls it a device admin app, limited here to turning
 * the screen off). Without it, or where the TV ignores it, the screen stays black.
 */
object AfterHours {
    fun admin(context: Context) = ComponentName(context, ScreenOffAdmin::class.java)

    private fun policy(context: Context) = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager

    fun canSleep(context: Context): Boolean = policy(context).isAdminActive(admin(context))

    /** "standby" when the player can put the device to sleep, otherwise "black". */
    fun mode(context: Context): String = if (canSleep(context)) "standby" else "black"

    /** Puts the device to sleep now (if allowed), and asks to be woken at [wakeAt]. */
    fun sleepUntil(context: Context, wakeAt: Long?) {
        if (wakeAt != null) scheduleWake(context, wakeAt)
        if (canSleep(context)) runCatching { policy(context).lockNow() }
    }

    private fun scheduleWake(context: Context, at: Long) {
        val alarms = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val intent = PendingIntent.getBroadcast(
            context, 0, Intent(context, WakeReceiver::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        // Exact alarms need extra permission on Android 12+; an inexact one is a few minutes late at worst.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarms.canScheduleExactAlarms()) {
            alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, intent)
        } else {
            alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, intent)
        }
    }

    /**
     * Opens Android's screen to allow "turn the screen off". Returns false if
     * this TV hides it; then it can be allowed from a computer (see [ADB_COMMAND]).
     */
    fun openPermissionScreen(activity: Activity): Boolean {
        val intent = Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN)
            .putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, admin(activity))
            .putExtra(
                DevicePolicyManager.EXTRA_ADD_EXPLANATION,
                "Lets Kiosk Player switch this screen off outside working hours, and back on at opening time.",
            )
        return try {
            activity.startActivity(intent)
            true
        } catch (e: ActivityNotFoundException) {
            false
        }
    }

    const val ADB_COMMAND = "adb shell dpm set-active-admin com.kiosk.player/.ScreenOffAdmin"
}

/** The permission holder for "turn the screen off". It does nothing else. */
class ScreenOffAdmin : DeviceAdminReceiver()

/** Wakes the device at opening time and brings the player back to the front. */
class WakeReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        // Switches the screen on (the way an alarm clock app does), long enough for the player to open.
        @Suppress("DEPRECATION")
        power.newWakeLock(
            PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP or PowerManager.ON_AFTER_RELEASE,
            "kiosk:opening",
        ).acquire(10_000)
        context.startActivity(
            Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT),
        )
    }
}
