package com.kiosk.core.player

import com.kiosk.core.model.PlayerItem
import com.kiosk.core.model.PlayerPlaylist
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import kotlin.coroutines.coroutineContext

/**
 * Keeps the TV's own copy of its playlist's files up to date, in [mediaDir].
 *
 * Each file is downloaded to "<name>.part" first. If the download is cut off,
 * the next try asks the server for just the rest ("Range" request). Only when
 * the whole file is there AND its md5 fingerprint matches is it renamed to its
 * final name, so the player never plays a broken file.
 */
class ContentSync(
    private val client: OkHttpClient,
    private val baseUrl: String,
    private val mediaDir: File,
) {
    init { mediaDir.mkdirs() }

    /** The finished file for an item (it may not exist yet). */
    fun fileFor(item: PlayerItem): File = File(mediaDir, "${item.id}-${item.md5}${extension(item)}")

    fun isReady(item: PlayerItem): Boolean = fileFor(item).let { it.exists() && it.length() == item.size }

    /**
     * Downloads every missing file of [playlist], one after another, and
     * deletes files no longer used. [onProgress] gets (files done, total).
     * Throws if a download fails; files already finished are kept.
     */
    suspend fun sync(playlist: PlayerPlaylist, onProgress: (Int, Int) -> Unit = { _, _ -> }) {
        val items = playlist.items.distinctBy { it.id to it.md5 }
        var done = items.count { isReady(it) }
        onProgress(done, items.size)
        for (item in items) {
            if (isReady(item)) continue
            download(item)
            done++
            onProgress(done, items.size)
        }
        removeUnused(items)
    }

    /** Deletes finished and partial files that aren't in [keep]. */
    fun removeUnused(keep: List<PlayerItem>) {
        val wanted = keep.map { fileFor(it).name }.toSet()
        mediaDir.listFiles()?.forEach { f ->
            val name = f.name.removeSuffix(".part")
            if (name !in wanted) f.delete()
        }
    }

    /** Free space on the TV's storage, reported to the admin app. */
    fun freeBytes(): Long = mediaDir.usableSpace

    private suspend fun download(item: PlayerItem) = withContext(Dispatchers.IO) {
        val target = fileFor(item)
        val part = File(mediaDir, target.name + ".part")
        if (part.length() > item.size) part.delete()

        val request = Request.Builder().url(baseUrl.trimEnd('/') + item.url).apply {
            if (part.length() > 0) header("Range", "bytes=${part.length()}-")
        }.build()

        client.newCall(request).execute().use { response ->
            if (response.code == 416) { part.delete(); throw DownloadException("${item.filename}: starting again") }
            if (!response.isSuccessful) throw DownloadException("${item.filename}: server answered ${response.code}")
            // 206 means "here is the rest"; 200 means the whole file, so start over.
            val append = response.code == 206
            val body = response.body ?: throw DownloadException("${item.filename}: empty reply")
            FileOutputStream(part, append).use { out ->
                body.byteStream().use { input ->
                    val buffer = ByteArray(256 * 1024)
                    while (true) {
                        coroutineContext.ensureActive()
                        val read = input.read(buffer)
                        if (read < 0) break
                        out.write(buffer, 0, read)
                    }
                }
            }
        }

        if (part.length() != item.size) throw DownloadException("${item.filename}: incomplete, will resume")
        if (!md5Of(part).equals(item.md5, ignoreCase = true)) {
            part.delete()
            throw DownloadException("${item.filename}: damaged download, starting again")
        }
        if (!part.renameTo(target)) throw DownloadException("${item.filename}: couldn't save")
    }

    private fun extension(item: PlayerItem): String =
        item.filename.substringAfterLast('.', "").lowercase().let { if (it.isEmpty()) "" else ".$it" }

    companion object {
        fun md5Of(file: File): String {
            val digest = MessageDigest.getInstance("MD5")
            file.inputStream().use { input ->
                val buffer = ByteArray(256 * 1024)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    digest.update(buffer, 0, read)
                }
            }
            return digest.digest().joinToString("") { "%02x".format(it) }
        }
    }
}

class DownloadException(message: String) : Exception(message)
