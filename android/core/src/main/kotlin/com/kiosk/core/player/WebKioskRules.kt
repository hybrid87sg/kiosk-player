package com.kiosk.core.player

import com.kiosk.core.model.PinHash
import java.net.URI
import java.security.MessageDigest

/**
 * A Web Kiosk's rules (0.12.0), the same as the Windows Kiosk Browser's
 * (windows/src/core/rules.js). Both are tested against shared/web-kiosk-rules.json.
 */
object WebKioskRules {
    /**
     * May the kiosk show this address? Pages on the start page's own website (and its
     * subdomains) always may; other websites only when listed ("*.example.com" covers
     * every subdomain). Nothing but http/https: no files, e-mail, apps or scripts.
     */
    fun isAllowed(address: String, startUrl: String, allowedHosts: List<String> = emptyList()): Boolean {
        if (address == "about:blank") return true
        val url = runCatching { URI(address) }.getOrNull() ?: return false
        val start = runCatching { URI(startUrl) }.getOrNull() ?: return false
        val scheme = url.scheme?.lowercase() ?: return false
        if (scheme != "http" && scheme != "https") return false
        val host = url.host?.lowercase() ?: return false
        val home = start.host?.lowercase()?.removePrefix("www.") ?: return false
        if (host == home || host.endsWith(".$home")) return true
        return allowedHosts.any { rule ->
            val r = rule.lowercase()
            if (r.startsWith("*.")) host == r.substring(2) || host.endsWith(r.substring(1))
            else host == r || host == "www.$r"
        }
    }

    /** Checks a typed staff PIN against the server's salted hash: sha256("salt:pin"). */
    fun pinMatches(pin: String, stored: PinHash?): Boolean {
        if (stored == null || stored.salt.isEmpty() || stored.sha256.isEmpty()) return false
        val got = MessageDigest.getInstance("SHA-256").digest("${stored.salt}:$pin".toByteArray(Charsets.UTF_8))
        val want = runCatching { stored.sha256.chunked(2).map { it.toInt(16).toByte() }.toByteArray() }.getOrNull() ?: return false
        return MessageDigest.isEqual(got, want)
    }
}
