package com.kiosk.admin.ui.library

import android.content.Context
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.provider.OpenableColumns
import com.kiosk.core.data.UploadSource

/**
 * Turns a file picked with Android's file picker (photos, Downloads, Google
 * Drive, ...) into something we can upload: its name, size, type and bytes.
 */
fun Context.uploadSourceFor(uri: Uri): UploadSource {
    var name = "upload"
    var size = -1L
    contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
        if (c.moveToFirst()) {
            c.getString(0)?.let { name = it }
            if (!c.isNull(1)) size = c.getLong(1)
        }
    }
    val mime = contentResolver.getType(uri) ?: "application/octet-stream"
    val (width, height) = runCatching { measure(uri, mime) }.getOrDefault(null to null)
    return UploadSource(name, mime, size, width, height) {
        contentResolver.openInputStream(uri) ?: error("Can't open $name")
    }
}

/** Width and height in pixels (turned the right way up), used by Demo mode. */
private fun Context.measure(uri: Uri, mime: String): Pair<Int?, Int?> =
    if (mime.startsWith("video/")) {
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(this, uri)
            val w = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull()
            val h = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull()
            val rotation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
            if (rotation == 90 || rotation == 270) h to w else w to h
        } finally {
            retriever.release()
        }
    } else {
        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) }
        options.outWidth.takeIf { it > 0 } to options.outHeight.takeIf { it > 0 }
    }
