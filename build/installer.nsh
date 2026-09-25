; 예전 버전(asar 포장)에서 올라올 때 남은 app.asar가 새 앱 폴더보다 먼저 읽히지 않도록 지운다
!macro customInstall
  Delete "$INSTDIR\resources\app.asar"
  RMDir /r "$INSTDIR\resources\app.asar.unpacked"
!macroend
