Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

!define PRODUCT_VERSION "0.9.11"
!define PAYLOAD_DIR "${__FILEDIR__}\..\release\native-win-x64"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\PWToolsNative"
Name "PWTools"
OutFile "${__FILEDIR__}\..\release\PWTools-Setup-${PRODUCT_VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\PWToolsNative"
InstallDirRegKey HKCU "${UNINSTALL_KEY}" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUninstDetails show
BrandingText "PWTools"
VIProductVersion "0.9.11.0"
VIAddVersionKey /LANG=1033 "ProductName" "PWTools"
VIAddVersionKey /LANG=1033 "FileDescription" "PWTools setup"
VIAddVersionKey /LANG=1033 "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "PWTools"
!define MUI_ICON "${__FILEDIR__}\..\build\icon.ico"
!define MUI_UNICON "${__FILEDIR__}\..\build\icon.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\PWTools.exe"
!define MUI_FINISHPAGE_RUN_TEXT "启动 PWTools"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH
!insertmacro MUI_LANGUAGE "SimpChinese"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "PWTools 需要 64 位 Windows 10 或更新版本。"
    SetErrorLevel 1
    Abort
  ${EndIf}
FunctionEnd

Section "PWTools" SEC_MAIN
  SetShellVarContext current
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=install-webview2.ps1 "${__FILEDIR__}\resources\install-webview2.ps1"
  runtime_retry:
    DetailPrint "检查 Microsoft Edge WebView2 运行时…"
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\install-webview2.ps1"'
    Pop $0
    ${If} $0 != 0
      IfSilent runtime_failure
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "无法安装 WebView2 运行时（错误 $0）。请检查网络连接后重试；也可从微软官网安装 WebView2 Evergreen 后重新运行安装程序。" IDRETRY runtime_retry
      runtime_failure:
      SetErrorLevel 1
      Abort "WebView2 运行时尚未安装。"
    ${EndIf}
  SetOutPath "$INSTDIR"
  File "${PAYLOAD_DIR}\PWTools.exe"
  SetOutPath "$INSTDIR\renderer"
  File /r "${PAYLOAD_DIR}\renderer\*"
  SetOutPath "$INSTDIR\licenses"
  File /r "${PAYLOAD_DIR}\licenses\*"
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall-PWTools.exe"
  CreateDirectory "$SMPROGRAMS\PWTools"
  CreateShortcut "$SMPROGRAMS\PWTools\PWTools.lnk" "$INSTDIR\PWTools.exe"
  CreateShortcut "$SMPROGRAMS\PWTools\卸载 PWTools.lnk" "$INSTDIR\Uninstall-PWTools.exe"
  CreateShortcut "$DESKTOP\PWTools.lnk" "$INSTDIR\PWTools.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "PWTools ${PRODUCT_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "PWTools"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\PWTools.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '$\"$INSTDIR\Uninstall-PWTools.exe$\"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '$\"$INSTDIR\Uninstall-PWTools.exe$\" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  Delete "$DESKTOP\PWTools.lnk"
  Delete "$SMPROGRAMS\PWTools\PWTools.lnk"
  Delete "$SMPROGRAMS\PWTools\卸载 PWTools.lnk"
  RMDir "$SMPROGRAMS\PWTools"
  Delete "$INSTDIR\PWTools.exe"
  RMDir /r "$INSTDIR\renderer"
  RMDir /r "$INSTDIR\licenses"
  Delete "$INSTDIR\Uninstall-PWTools.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  ; The shared WebView2 runtime and the user's ledger/session data are retained.
SectionEnd
