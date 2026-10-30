package com.kiosk.core.player

import com.kiosk.core.model.ServerConfig
import com.kiosk.core.network.json
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/** A Kiosk server found on the network: the main one, or a relay for one site. */
data class FoundServer(
    val url: String,
    val serverId: String,
    val role: String?,
    val siteName: String?,
)

/**
 * Finds Kiosk servers on the TV's home network, so nobody has to type an address.
 *
 * It "knocks" on every address in the TV's own network (e.g. 192.168.1.1 to
 * 192.168.1.254), asking each one "are you a Kiosk server?" on port 3000.
 * Most addresses don't answer at all; the few that do are asked for
 * /api/config, and a Kiosk server says kind = "kiosk-signage". Many knocks
 * happen at once, so a whole network takes a few seconds.
 */
class ServerFinder(
    private val port: Int = 3000,
    private val parallel: Int = 48,
    client: OkHttpClient = OkHttpClient(),
) {
    // Quick give-up times: a device that is there answers within a moment.
    private val client = client.newBuilder()
        .connectTimeout(700, TimeUnit.MILLISECONDS)
        .readTimeout(2, TimeUnit.SECONDS)
        .callTimeout(3, TimeUnit.SECONDS)
        .build()

    /**
     * Searches the network that [ownAddress] (the TV's IPv4 address) is on.
     * With [serverId], only that server counts (used to find "our" server
     * again after its address changed).
     */
    suspend fun find(ownAddress: String, serverId: String? = null): List<FoundServer> = coroutineScope {
        val gate = Semaphore(parallel)
        neighbours(ownAddress)
            .map { address -> async(Dispatchers.IO) { gate.withPermit { ask("http://$address:$port/") } } }
            .awaitAll()
            .filterNotNull()
            .filter { serverId == null || it.serverId == serverId }
            // The main server first, then relays by site name.
            .sortedWith(compareBy({ it.role == "relay" }, { it.siteName.orEmpty() }))
    }

    /** Asks one address whether it's a Kiosk server. */
    suspend fun ask(url: String): FoundServer? = withContext(Dispatchers.IO) {
        runCatching {
            client.newCall(Request.Builder().url("${url}api/config").build()).execute().use { reply ->
                if (!reply.isSuccessful) return@use null
                val config = json.decodeFromString(ServerConfig.serializer(), reply.body!!.string())
                val id = config.serverId
                if (config.kind != "kiosk-signage" || id == null) null
                else FoundServer(url, id, config.role, config.siteName)
            }
        }.getOrNull()
    }

    companion object {
        /**
         * Every other address in the same home network as [ownAddress]: for
         * "192.168.1.37" that's 192.168.1.1 to 192.168.1.254, without .37 itself.
         * Home networks are almost always this size (a "/24").
         */
        fun neighbours(ownAddress: String): List<String> {
            val parts = ownAddress.trim().split('.')
            require(parts.size == 4 && parts.all { it.toIntOrNull() in 0..255 }) { "Not an IPv4 address: $ownAddress" }
            val prefix = parts.take(3).joinToString(".")
            val own = parts[3].toInt()
            return (1..254).filter { it != own }.map { "$prefix.$it" }
        }
    }
}
