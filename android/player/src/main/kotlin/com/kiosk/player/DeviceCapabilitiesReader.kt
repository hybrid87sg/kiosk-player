package com.kiosk.player

import android.content.Context
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.os.Build
import android.view.WindowManager
import com.kiosk.core.model.DeviceCapabilities
import com.kiosk.core.player.avcLevelNumber

/**
 * Reads the TV's current output size and the hardware video decoders.
 * Software decoders are ignored when a hardware one exists, because a software
 * decoder that claims 4K will not play 4K smoothly.
 */
object DeviceCapabilitiesReader {
    fun read(context: Context): DeviceCapabilities {
        val (width, height) = displaySize(context)
        val avc = limitsFor("video/avc")
        val hevc = limitsFor("video/hevc")
        val level = avc?.maxLevel?.let { avcLevelNumber(it) }?.takeIf { it > 0 }
        return DeviceCapabilities(
            displayWidth = width,
            displayHeight = height,
            h264Level = level,
            h264MaxLong = avc?.maxLong,
            h264MaxShort = avc?.maxShort,
            hevc = hevc != null,
            hevcMaxLong = hevc?.maxLong,
            hevcMaxShort = hevc?.maxShort,
        )
    }

    private fun displaySize(context: Context): Pair<Int, Int> {
        val manager = context.getSystemService(WindowManager::class.java) ?: return 0 to 0
        return try {
            @Suppress("DEPRECATION")
            val mode = manager.defaultDisplay.mode
            mode.physicalWidth to mode.physicalHeight
        } catch (e: RuntimeException) {
            0 to 0
        }
    }

    private data class Limits(val maxLong: Int, val maxShort: Int, val maxLevel: Int)

    private fun limitsFor(mime: String): Limits? {
        val infos = try {
            MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos
        } catch (e: RuntimeException) {
            return null
        }
        val hardware = mutableListOf<Limits>()
        val software = mutableListOf<Limits>()
        for (info in infos) {
            if (info.isEncoder) continue
            val types = try {
                info.supportedTypes
            } catch (e: RuntimeException) {
                continue
            }
            if (types.none { it.equals(mime, ignoreCase = true) }) continue
            val limits = codecLimits(info, mime) ?: continue
            if (isSoftware(info)) software += limits else hardware += limits
        }
        val pool = hardware.ifEmpty { software }
        if (pool.isEmpty()) return null
        return Limits(pool.maxOf { it.maxLong }, pool.maxOf { it.maxShort }, pool.maxOf { it.maxLevel })
    }

    private fun codecLimits(info: MediaCodecInfo, mime: String): Limits? = try {
        val caps = info.getCapabilitiesForType(mime)
        val video = caps.videoCapabilities ?: return null
        val maxWidth = video.supportedWidths.upper
        val maxHeight = video.supportedHeights.upper
        val level = caps.profileLevels.maxOfOrNull { it.level } ?: 0
        Limits(maxOf(maxWidth, maxHeight), minOf(maxWidth, maxHeight), level)
    } catch (e: Exception) {
        null
    }

    private fun isSoftware(info: MediaCodecInfo): Boolean {
        if (Build.VERSION.SDK_INT >= 29) return info.isSoftwareOnly
        val name = info.name.lowercase()
        return name.startsWith("omx.google.") || name.startsWith("c2.android.")
    }
}
