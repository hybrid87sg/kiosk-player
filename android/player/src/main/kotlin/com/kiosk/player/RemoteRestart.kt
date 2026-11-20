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
    /** When this run of the app started: a restart is only "done" if it started after the request. */
    private val startedAt = System.currentTimeMillis()
    /** A request that couldn't be carried out, reported until the server has heard. */
    @Volatile private var failed: JobReport? = null

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
        failed?.takeIf { it.id == request.id }?.let { return it }
        if (settings.restartDoneId == request.id) {
            if (startedAt > settings.restartAskedAt) return JobReport(request.id, "done")
            // Still the same run, well after it was asked: it didn't restart.
            if (System.currentTimeMillis() - settings.restartAskedAt > 2 * 60_000L) {
                return JobReport(request.id, "failed", error = "It didn't restart.").also { failed = it }
            }
            return null
        }
        val problem = when {
            request.kind == "device" && !canRebootDevice(context) ->
                "Android doesn't let Kiosk Player restart this box (it isn't the box's device owner)."
            request.kind != "device" && !canReopen(context) ->
                "Kiosk Player couldn't reopen itself: in its Settings, switch on “Come back to the front automatically”, or make it the home screen."
            else -> null
        }
        if (problem != null) return JobReport(request.id, "failed", error = problem).also { failed = it }
        settings.restartDoneId = request.id
        settings.restartAskedAt = System.currentTimeMillis()
        if (request.kind == "device") {
            Log.i(TAG, "Restarting the device, as asked on the dashboard")
            val error = runCatching {
                val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
                dpm.reboot(AfterHours.admin(context))
            }.exceptionOrNull()
            return error?.let { JobReport(request.id, "failed", error = "The device didn't restart (${it.javaClass.simpleName}).") }
                ?.also { failed = it }
        }
        Log.i(TAG, "Restarting the app, as asked on the dashboard")
        Watchdog.arm(context.applicationContext, REOPEN_AFTER_MS)
        // An ordinary exit, so it isn't reported as "closed by itself" afterwards.
        exitProcess(0)
    }
}
