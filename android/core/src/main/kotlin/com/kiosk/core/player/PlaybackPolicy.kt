package com.kiosk.core.player

import kotlin.math.abs
import kotlin.math.round

/** One refresh rate the TV panel can switch to. */
data class RefreshMode(val id: Int, val width: Int, val height: Int, val refreshRate: Float)

/** Snap 23.98 to 23.976 and 59.94-ish values onto the rate panels actually advertise. */
fun roundFrameRate(fps: Float): Float {
    if (fps <= 0f) return fps
    val common = floatArrayOf(23.976f, 24f, 25f, 29.97f, 30f, 50f, 59.94f, 60f)
    val nearest = common.minBy { abs(it - fps) }
    return if (abs(nearest - fps) < 0.05f) nearest else fps
}

/**
 * A panel mode change blanks HDMI unless the target refresh is one the current
 * mode can switch to seamlessly. Already being on that rate needs no change.
 */
fun seamlessRefreshSwitch(currentRefresh: Float, alternativeRefreshes: FloatArray, targetRefresh: Float): Boolean {
    val target = roundFrameRate(targetRefresh)
    if (target < 1f) return false
    if (abs(currentRefresh - target) < 1f) return false
    return alternativeRefreshes.any { abs(it - target) < 1f }
}

/**
 * Picks a panel mode whose refresh rate is the content frame rate, or a whole
 * multiple of it (30fps on a 60Hz panel). Returns null when nothing is close,
 * so the player leaves the panel alone.
 */
fun chooseDisplayMode(modes: List<RefreshMode>, width: Int, height: Int, frameRate: Float): Int? {
    val fps = roundFrameRate(frameRate)
    if (fps < 1f || width <= 0 || height <= 0) return null
    val sameSize = modes.filter { it.width == width && it.height == height }
    if (sameSize.isEmpty()) return null
    fun multipleError(rate: Float): Float {
        val ratio = rate / fps
        val nearest = round(ratio).toInt().coerceAtLeast(1)
        return abs(ratio - nearest)
    }
    val best = sameSize.minWith(
        compareBy<RefreshMode> { multipleError(it.refreshRate) }.thenBy { abs(it.refreshRate - frameRate) },
    )
    if (multipleError(best.refreshRate) > 0.02f) return null
    return best.id
}

/** How long to wait after a playback error before trying the next item. */
fun playbackRetryDelayMs(consecutiveFailures: Int): Long {
    val shift = (consecutiveFailures.coerceAtLeast(1) - 1).coerceAtMost(4)
    return (5_000L shl shift).coerceAtMost(60_000L)
}

/**
 * Android's CodecProfileLevel.AVCLevel* bit to a level number, where 41 means 4.1.
 * Unknown bits return 0.
 */
fun avcLevelNumber(androidLevel: Int): Int = AVC_LEVEL_NUMBERS[androidLevel] ?: 0

private val AVC_LEVEL_NUMBERS = mapOf(
    0x01 to 10,
    0x02 to 9,
    0x04 to 11,
    0x08 to 12,
    0x10 to 13,
    0x20 to 20,
    0x40 to 21,
    0x80 to 22,
    0x100 to 30,
    0x200 to 31,
    0x400 to 32,
    0x800 to 40,
    0x1000 to 41,
    0x2000 to 42,
    0x4000 to 50,
    0x8000 to 51,
    0x10000 to 52,
    0x20000 to 60,
    0x40000 to 61,
    0x80000 to 62,
)

/** Leave this much free so the TV can still write its own files. */
const val DOWNLOAD_HEADROOM_BYTES = 64L * 1024 * 1024

fun enoughFreeSpace(freeBytes: Long, bytesStillNeeded: Long, headroom: Long = DOWNLOAD_HEADROOM_BYTES): Boolean {
    if (bytesStillNeeded <= 0) return true
    return freeBytes >= bytesStillNeeded + headroom
}

/** Text for a video that is larger than the 1080p safe size. Pictures return null. */
fun heavyVideoWarning(typeIsVideo: Boolean, width: Int?, height: Int?): String? {
    if (!typeIsVideo || width == null || height == null || width <= 0 || height <= 0) return null
    if (maxOf(width, height) <= 1920 && minOf(width, height) <= 1080) return null
    return "This video is ${width}×${height}. Some TV boxes may not play it smoothly until a 1080p copy is ready."
}
