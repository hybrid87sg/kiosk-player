package com.kiosk.core.network

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import retrofit2.HttpException
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import java.io.IOException
import java.util.concurrent.TimeUnit

/** A problem talking to the server, with a message that can be shown to people. */
class ApiException(message: String, val status: Int? = null) : Exception(message)

internal val json = Json {
    ignoreUnknownKeys = true // the server may add fields later; don't crash on them
    explicitNulls = false
    encodeDefaults = true
}

/**
 * Builds the HTTP client for one server address. [token] is read on every
 * request, so signing in or out takes effect straight away.
 */
internal class ServerConnection(baseUrl: String, private val token: () -> String?) {
    val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(0, TimeUnit.SECONDS) // big uploads can take a long time
        .addInterceptor { chain ->
            val request = chain.request().newBuilder()
            token()?.let { request.header("Authorization", "Bearer $it") }
            chain.proceed(request.build())
        }
        .build()

    val baseUrl: String = normaliseBaseUrl(baseUrl)

    val retrofit: Retrofit = Retrofit.Builder()
        .baseUrl(this.baseUrl)
        .client(client)
        .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
        .build()

    inline fun <reified T> create(): T = retrofit.create(T::class.java)
}

/** "signage.example.com" -> "https://signage.example.com/" */
fun normaliseBaseUrl(input: String): String {
    var url = input.trim()
    if (!url.startsWith("http://") && !url.startsWith("https://")) url = "https://$url"
    if (!url.endsWith("/")) url += "/"
    return url
}

/**
 * Runs one server call and turns failures into [ApiException] with a readable
 * message: the server's own "error" text when it sent one.
 */
internal suspend fun <T> apiCall(block: suspend () -> T): T =
    try {
        block()
    } catch (e: HttpException) {
        val body = e.response()?.errorBody()?.string()
        val message = body?.let {
            runCatching { json.parseToJsonElement(it).jsonObject["error"]?.jsonPrimitive?.content }.getOrNull()
        }
        throw ApiException(message ?: "The server answered with error ${e.code()}", e.code())
    } catch (e: IOException) {
        throw ApiException("Can't reach the server. Check the address and your internet connection.")
    }
