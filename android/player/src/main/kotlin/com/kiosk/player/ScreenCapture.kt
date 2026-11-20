package com.kiosk.player

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Matrix
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import kotlinx.coroutines.suspendCancellableCoroutine
import java.io.ByteArrayOutputStream
import kotlin.coroutines.resume
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * See screen (0.13.0): a picture of what the player shows, taken by the app itself,
 * so Android never asks "Start recording?".
 *
 * The app's window is copied with PixelCopy. A video playing in a SurfaceView is drawn
 * on its own layer, not in the window (the window has a see-through hole there), so
 * each SurfaceView is copied too and put underneath. Web pages and turned videos
 * (TextureView) are part of the window already.
 *
 * On a screen mounted sideways or upside down the app turns its picture; the copy is
 * turned back by the same amount, so the dashboard shows it the way people see it.
 */
object ScreenCapture {
    private const val LONGEST_SIDE = 1280
    private const val QUALITY = 75

    class Problem(message: String) : Exception(message)

    /** JPEG bytes. Throws [Problem] with a sentence for the dashboard. */
    suspend fun take(activity: Activity, turnDegrees: Int): ByteArray {
        val window = activity.window
        val decor = window.decorView
        val width = decor.width
        val height = decor.height
        if (width <= 0 || height <= 0 || !decor.isAttachedToWindow) throw Problem("Kiosk Player isn't on screen right now.")

        val windowCopy = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        copy(windowCopy) { done -> PixelCopy.request(window, windowCopy, done, Handler(Looper.getMainLooper())) }

        val picture = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(picture)
        canvas.drawColor(android.graphics.Color.BLACK)
        // Videos first (they're behind the window), then the window on top.
        for (surface in surfaceViews(decor)) {
            if (!surface.isShown || surface.width <= 0 || surface.height <= 0 || !surface.holder.surface.isValid) continue
            val frame = Bitmap.createBitmap(surface.width, surface.height, Bitmap.Config.ARGB_8888)
            val ok = runCatching {
                copy(frame) { done -> PixelCopy.request(surface, frame, done, Handler(Looper.getMainLooper())) }
            }.isSuccess
            if (ok) {
                val at = IntArray(2).also { surface.getLocationInWindow(it) }
                canvas.drawBitmap(frame, at[0].toFloat(), at[1].toFloat(), null)
            }
            frame.recycle()
        }
        canvas.drawBitmap(windowCopy, 0f, 0f, null)
        windowCopy.recycle()

        // Smaller, and the way people in the room see it.
        val scale = minOf(1f, LONGEST_SIDE.toFloat() / max(width, height))
        val matrix = Matrix().apply {
            postScale(scale, scale)
            if (turnDegrees % 360 != 0) postRotate(turnDegrees.toFloat())
        }
        val shown = Bitmap.createBitmap(picture, 0, 0, width, height, matrix, true)
        if (shown !== picture) picture.recycle()
        val out = ByteArrayOutputStream()
        shown.compress(Bitmap.CompressFormat.JPEG, QUALITY, out)
        shown.recycle()
        return out.toByteArray()
    }

    private fun surfaceViews(view: View): List<SurfaceView> = when (view) {
        is SurfaceView -> listOf(view)
        is ViewGroup -> (0 until view.childCount).flatMap { surfaceViews(view.getChildAt(it)) }
        else -> emptyList()
    }

    private suspend fun copy(target: Bitmap, request: (PixelCopy.OnPixelCopyFinishedListener) -> Unit) {
        val result = suspendCancellableCoroutine { cont ->
            try {
                request { code -> if (cont.isActive) cont.resume(code) }
            } catch (e: IllegalArgumentException) {
                if (cont.isActive) cont.resume(PixelCopy.ERROR_SOURCE_INVALID)
            }
        }
        when (result) {
            PixelCopy.SUCCESS -> Unit
            PixelCopy.ERROR_SOURCE_NO_DATA -> throw Problem("There's nothing on the screen right now (it may be in standby after hours).")
            PixelCopy.ERROR_SOURCE_INVALID -> throw Problem("Kiosk Player isn't on screen right now.")
            PixelCopy.ERROR_TIMEOUT -> throw Problem("The screen took too long to answer.")
            else -> throw Problem("The screen couldn't take a picture (error $result).")
        }
        if (target.isRecycled) throw Problem("The screen couldn't take a picture.")
    }

    /** Rounds for logging; kept small so a big picture is still cheap to send. */
    fun describe(bytes: ByteArray) = "${(bytes.size / 1024f).roundToInt()} KB"
}
