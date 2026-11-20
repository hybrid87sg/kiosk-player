package com.kiosk.player

import android.app.admin.DevicePolicyManager
import android.content.Context
import android.util.Log
import com.kiosk.core.model.JobReport
import com.kiosk.core.model.RestartRequest
import kotlin.system.exitProcess

/**
 * Restart from the dashboard (0.13.0).
 *
 * "Restart app": the Watchdog alarm is set to open the player again in a few seconds,
 * then the app closes itself. That needs the player to be allowed to come back by
 * itself: "Display over other apps" (Keep in front), or being the TV's home screen.
 *
 * "Restart device": Android only lets an app restart the whole box when the app is
 * its device owner (set up once with adb, see the README). Otherwise the dashboard
 * greys that choice out ([canRebootDevice] is sent with the heartbeat).
 *
 * The request's id is saved before closing, so once the app is running again it
 * reports "done" instead of restarting a second time.
 */
object RemoteRestart {
    private const val TAG = "KioskRestart"
    private const val REOPEN_AFTER_MS = 2_000L

    fun canRebootDevice(context: Context): Boolean = runCatching {
        val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        dpm.isDeviceOwnerApp(context.packageName)
    }.getOrDefault(false)

    /** The player can open itself again after closing. */
    fun canReopen(context: Context): Boolean = KeepInFront.hasPermission(context) || HomeScreen.isDefault(context)

    /**
     * What to report for [request] (null when there's nothing to report), restarting
     * first if it's new. Returns only when it doesn't restart.
     */
    fun handle(context: Context, request: RestartRequest?, settings: PlayerSettings): JobReport? {
        if (request == null) {
            settings.restartDoneId = null
            return null
        }
        if (settings.restartDoneId == request.id) return JobReport(request.id, "done")
        val problem = when {
            request.kind == "device" && !canRebootDevice(context) ->
                "Android doesn't let Kiosk Player restart this box (it isn't the box's device owner)."
            request.kind != "device" && !canReopen(context) ->
                "Kiosk Player couldn't reopen itself: allow it to display over other apps (Settings → Keep in front), or make it the home screen."
            else -> null
        }
        if (problem != null) {
            settings.restartDoneId = request.id
            return JobReport(request.id, "failed", error = problem)
        }
        settings.restartDoneId = request.id
        if (request.kind == "device") {
            Log.i(TAG, "Restarting the device, as asked on the dashboard")
            val failed = runCatching {
                val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
                dpm.reboot(AfterHours.admin(context))
            }.exceptionOrNull()
            return failed?.let { JobReport(request.id, "failed", error = "The device didn't restart (${it.javaClass.simpleName}).") }
        }
        Log.i(TAG, "Restarting the app, as asked on the dashboard")
        settings.restartAskedAt = System.currentTimeMillis()
        Watchdog.arm(context.applicationContext, REOPEN_AFTER_MS)
        // An ordinary exit, so it isn't reported as "closed by itself" afterwards.
        exitProcess(0)
    }
}
