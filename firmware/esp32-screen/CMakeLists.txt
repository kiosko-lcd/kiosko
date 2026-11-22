cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
# Reconfigure when the version changes, or the image keeps the old one.
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${CMAKE_CURRENT_LIST_DIR}/version.txt")
file(READ "${CMAKE_CURRENT_LIST_DIR}/version.txt" KS_VERSION)
string(STRIP "${KS_VERSION}" PROJECT_VER)
project(kiosko_screen)
