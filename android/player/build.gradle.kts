// Kiosk Player: the Android TV app that shows the playlist full screen.
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "com.kiosk.player"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.kiosk.player"
        minSdk = 26
        targetSdk = 35
        versionCode = 10
        versionName = "0.11.0"
    }

    signingConfigs {
        getByName("debug") {
            storeFile = rootProject.file("keystore/kiosk-debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures {
        compose = true
        buildConfig = true
    }
}

dependencies {
    implementation(project(":core"))
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons.extended)
    implementation(libs.media3.exoplayer)
    implementation(libs.coil.compose)
    implementation(libs.zxing.core)
}
