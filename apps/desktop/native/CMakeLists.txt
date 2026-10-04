cmake_minimum_required(VERSION 3.24)
project(PWTools VERSION 0.9.4 LANGUAGES CXX RC)

if(NOT WIN32 OR NOT MSVC)
  message(FATAL_ERROR "PWTools requires Windows and the MSVC C++ build tools.")
endif()
if(NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(FATAL_ERROR "This package targets Windows x64; configure with -A x64.")
endif()

set(WEBVIEW2_SDK "${CMAKE_CURRENT_SOURCE_DIR}/.deps/webview2-1.0.4191.47")
set(NLOHMANN_INCLUDE "${CMAKE_CURRENT_SOURCE_DIR}/.deps/nlohmann-3.12.0/include")
if(NOT EXISTS "${WEBVIEW2_SDK}/build/native/include/WebView2.h" OR
   NOT EXISTS "${NLOHMANN_INCLUDE}/nlohmann/json.hpp")
  message(FATAL_ERROR "Native SDKs are missing. Run scripts/native-prepare.ps1 first.")
endif()

set(PWTOOLS_API_URL "http://localhost:8080/api" CACHE STRING "Public API endpoint baked into the desktop executable")
if(DEFINED ENV{PWTOOLS_API_URL} AND NOT "$ENV{PWTOOLS_API_URL}" STREQUAL "")
  set(PWTOOLS_API_URL "$ENV{PWTOOLS_API_URL}")
endif()
if(NOT PWTOOLS_API_URL MATCHES "^https?://[^ \t\r\n]+$")
  message(FATAL_ERROR "PWTOOLS_API_URL must be an absolute HTTP or HTTPS URL without whitespace.")
endif()
string(REPLACE "\\" "\\\\" PWTOOLS_API_URL_ESCAPED "${PWTOOLS_API_URL}")
string(REPLACE "\"" "\\\"" PWTOOLS_API_URL_ESCAPED "${PWTOOLS_API_URL_ESCAPED}")
configure_file(resources/config.hpp.in generated/config.hpp @ONLY)

add_executable(PWTools WIN32 src/main.cpp src/api_bridge.cpp resources/app.rc)
target_compile_features(PWTools PRIVATE cxx_std_20)
set_property(TARGET PWTools PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
target_include_directories(PWTools PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/resources"
  "${CMAKE_CURRENT_BINARY_DIR}/generated"
  "${WEBVIEW2_SDK}/build/native/include"
  "${NLOHMANN_INCLUDE}")
target_compile_definitions(PWTools PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
target_compile_options(PWTools PRIVATE /W4 /utf-8 /EHsc /permissive- /guard:cf
  "$<$<CONFIG:Release>:/O2;/Gy;/Gw;/GL>")
target_link_options(PWTools PRIVATE /MANIFEST:NO /DYNAMICBASE /HIGHENTROPYVA /guard:cf
  "$<$<CONFIG:Release>:/LTCG;/OPT:REF;/OPT:ICF>")
target_link_libraries(PWTools PRIVATE
  "${WEBVIEW2_SDK}/build/native/x64/WebView2LoaderStatic.lib"
  winhttp crypt32 bcrypt shlwapi ole32 oleaut32 shell32 user32 gdi32 dwmapi comctl32 version)

set(PWTOOLS_DEPLOY_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../release/native-win-x64" CACHE PATH "Native distribution directory")
set_target_properties(PWTools PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${PWTOOLS_DEPLOY_DIR}")
foreach(config DEBUG RELEASE RELWITHDEBINFO MINSIZEREL)
  set_target_properties(PWTools PROPERTIES "RUNTIME_OUTPUT_DIRECTORY_${config}" "${PWTOOLS_DEPLOY_DIR}")
endforeach()

include(CTest)
if(BUILD_TESTING)
  add_executable(api_bridge_test EXCLUDE_FROM_ALL tests/api_bridge_test.cpp src/api_bridge.cpp)
  target_compile_features(api_bridge_test PRIVATE cxx_std_20)
  set_property(TARGET api_bridge_test PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
  target_include_directories(api_bridge_test PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src" "${NLOHMANN_INCLUDE}")
  target_compile_definitions(api_bridge_test PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
  target_compile_options(api_bridge_test PRIVATE /W4 /utf-8 /EHsc /permissive-)
  target_link_libraries(api_bridge_test PRIVATE winhttp crypt32 bcrypt ws2_32)
  set_target_properties(api_bridge_test PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/tests")
  foreach(config DEBUG RELEASE RELWITHDEBINFO MINSIZEREL)
    set_target_properties(api_bridge_test PROPERTIES "RUNTIME_OUTPUT_DIRECTORY_${config}" "${CMAKE_CURRENT_BINARY_DIR}/tests")
  endforeach()
  add_test(NAME api_bridge_fixtures COMMAND api_bridge_test)
  set_tests_properties(api_bridge_fixtures PROPERTIES TIMEOUT 60)
endif()
