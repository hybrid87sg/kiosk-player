package com.kiosk.player

import android.app.Activity
import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.IntentCompat
import com.kiosk.core.model.AppUpdate
import com.kiosk.core.model.JobReport
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import kotlin.coroutines.coroutineContext

/**
 * Updates Kiosk Player from its own server (0.11.0): the dashboard asks, the TV
 * downloads the app that came with the server, checks it's exactly that file,
 * and hands it to Android's installer.
 *
 * Android asks for the one-time "Install unknown apps" permission. On Android 12
 * and newer, once the player has installed itself once, later updates need no
 * one at the TV; older versions show an Install button every time.
 */
object AppUpdater {
    private const val EXTRA_UPDATE_ID = "com.kiosk.player.UPDATE_ID"

    /** "Install unknown apps" is allowed for Kiosk Player. */
    fun canInstall(context: Context): Boolean = context.packageManager.canRequestPackageInstalls()

    /** Downloads the app and checks its size and fingerprint. */
    suspend fun download(context: Context, client: OkHttpClient, baseUrl: String, update: AppUpdate): File = withContext(Dispatchers.IO) {
        val dir = File(context.filesDir, "update").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() } // an older download
        val part = File(dir, "kiosk-player.apk.part")
        val request = Request.Builder().url(baseUrl.trimEnd('/') + update.url).build()
        val digest = MessageDigest.getInstance("SHA-256")
        try {
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) throw IOException("the server answered ${response.code}")
                val body = response.body ?: throw IOException("empty reply")
                part.outputStream().use { out ->
                    body.byteStream().use { input ->
                        val buffer = ByteArray(256 * 1024)
                        while (true) {
                            coroutineContext.ensureActive()
                            val read = input.read(buffer)
                            if (read < 0) break
                            digest.update(buffer, 0, read)
                            out.write(buffer, 0, read)
                        }
                    }
                }
            }
        } catch (e: IOException) {
            part.delete()
            throw UpdateException("Download stopped: ${e.message}")
        }
        val sha256 = digest.digest().joinToString("") { "%02x".format(it) }
        if (part.length() != update.size || !sha256.equals(update.sha256, ignoreCase = true)) {
            part.delete()
            throw UpdateException("The download was damaged. It will be tried again if you press Update.")
        }
        File(dir, "kiosk-player.apk").also { if (!part.renameTo(it)) throw UpdateException("Couldn't save the download") }
    }

    /** Hands the app to Android's installer. The result arrives in [InstallResultReceiver]. */
    fun install(context: Context, apk: File, updateId: String) {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            // Android 12+: no Install button once the player installed itself before.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
            }
        }
        val sessionId = installer.createSession(params)
        installer.openSession(sessionId).use { session ->
            session.openWrite("kiosk-player", 0, apk.length()).use { out ->
                apk.inputStream().use { it.copyTo(out) }
                session.fsync(out)
            }
            val result = Intent(context, InstallResultReceiver::class.java).putExtra(EXTRA_UPDATE_ID, updateId)
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
            session.commit(PendingIntent.getBroadcast(context, sessionId, result, flags).intentSender)
        }
    }

    /** Opens Android's "Install unknown apps" screen for Kiosk Player. False: this TV hides it ([ADB_COMMAND]). */
    fun openPermissionScreen(activity: Activity): Boolean {
        val choices = listOf(
            Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")),
            Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES),
        )
        for (intent in choices) {
            try {
                activity.startActivity(intent)
                return true
            } catch (e: ActivityNotFoundException) {
                // try the next one
            }
        }
        return false
    }

    const val ADB_COMMAND = "adb shell appops set com.kiosk.player REQUEST_INSTALL_PACKAGES allow"

    internal fun updateIdOf(intent: Intent): String? = intent.getStringExtra(EXTRA_UPDATE_ID)
}

class UpdateException(message: String) : Exception(message)

/** Android's answer to an install: asks someone to press Install, or says how it went. */
class InstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = AppUpdater.updateIdOf(intent) ?: return
        val settings = PlayerSettings(context)
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                settings.updateReport = JobReport(id, "waiting_for_install")
                // Leave Android's Install screen on top: don't jump back over it.
                KeepInFront.pauseFor(context, 10)
                IntentCompat.getParcelableExtra(intent, Intent.EXTRA_INTENT, Intent::class.java)?.let {
                    runCatching { context.startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                }
            }
            PackageInstaller.STATUS_SUCCESS -> settings.updateReport = JobReport(id, "installing")
            PackageInstaller.STATUS_FAILURE_ABORTED ->
                settings.updateReport = JobReport(id, "failed", error = "Cancelled on the TV (or nobody pressed Install in time)")
            PackageInstaller.STATUS_FAILURE_STORAGE ->
                settings.updateReport = JobReport(id, "failed", error = "Not enough free space on the TV")
            PackageInstaller.STATUS_FAILURE_CONFLICT, PackageInstaller.STATUS_FAILURE_INCOMPATIBLE ->
                settings.updateReport = JobReport(id, "failed", error = "Android refused it: it doesn't match the app on this TV${message?.let { " ($it)" }.orEmpty()}")
            else -> settings.updateReport = JobReport(id, "failed", error = "Android couldn't install it${message?.let { ": $it" }.orEmpty()}")
        }
        if (settings.updateReport?.step == "failed") KeepInFront.resume(context)
    }
}

/** After an update Android closes the old app: this opens the new one straight away. */
class AppReplacedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        KeepInFront.resume(context)
        runCatching { KeepInFront.bringBack(context) }
    }
}
