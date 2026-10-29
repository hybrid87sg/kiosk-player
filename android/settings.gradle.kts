// The Android project: one shared module and two apps.
//   core    plain Kotlin: data shapes, talking to the server, and Demo mode data
//   admin   Kiosk Admin, the phone app
//   player  Kiosk Player, the Android TV app

pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "KioskSignage"
include(":core", ":admin", ":player")
