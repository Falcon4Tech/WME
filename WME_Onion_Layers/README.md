# WME Onion Layers 🧅

Userscript do **Waze Map Editor**, który dodaje **zewnętrzne warstwy mapowe** (WMS / GeoJSON) i integruje je z **natywnym menu WME**.

Dlaczego *Onion*?  
Bo:
- cebula ma warstwy,
- WME ma warstwy,
- a ten skrypt dokłada kolejne – jedna na drugiej 😉

---

### Zintegrowane warstwy

- OPP - Odcinkowy Pomiar Prędkości
  - odcinki istniejące
  - odcinki projektowane

- Granice - obręby
  - jednostki ewidencyjne, obręby miejscowości

- Miasta
  - wyróżnienie obszaru na prawach mieskich

---

### Co robi skrypt

- dodaje własną grupę **„Warstwy”** do menu,
- obsługuje warstwy:
  - **WMS** (np. e-mapa, geoportal),
  - **GeoJSON**,
- działa **jak natywne warstwy WME**:
  - checkboxy,
  - przełącznik grupy,
  - zwijanie / rozwijanie,
  - zapamiętywanie stanu.

---

### Najważniejsze cechy

- ✅ integracja z istniejącym UI WME
- ✅ poprawne projekcje (WME ⇄ WMS)
- ✅ kafelkowanie (tylko brakujące tile są dociągane)
- ✅ zapamiętywanie stanu warstw i grupy w `localStorage`
- ✅ brak overlay paneli / floating UI

---

### Zakres działania

⚠️ **Skrypt przeznaczony jest wyłącznie do pracy na terenie Polski**

Źródła danych:
- polskie WMS (e-mapa, geoportal, GUGiK),
- GeoJSON przygotowany pod PL.

Poza Polską warstwy **nie mają pokrycia**.

---

### Obsługiwane typy warstw
- WMS
  - dynamiczne pobieranie kafelków,
  - obsługa zoomu i przesuwania mapy,
  - automatyczna konwersja do projekcji WME.

- GeoJSON
  - punkty / linie / poligony,
  - dane z URL lub inline,
  - render jako warstwa wektorowa.

---

### Instalacja

1. Zainstaluj Tampermonkey lub Violentmonkey
2. Zainstaluj plik: `wme_onion.user.js`
3. Odśwież Waze Map Editor

Warstwy pojawią się w:
> **Menu → Warstwy**

---

### Stan i konfiguracja

- stan warstw i grupy zapisywany jest w `localStorage`,
- używany jest **jeden klucz JSON** (brak śmiecenia storage),

Przy starcie WME: warstwy, grupa, zwinięcie/rozwinięcie – są odtwarzane automatycznie.

---

## Status projektu

Skrypt jest:
- aktywnie rozwijany,
- dostosowywany do zmian w WME,
- pisany „pod edytora”, nie obok niego.

Jeśli po aktualizacji WME coś się rozjedzie – poprawki pojawią się w kolejnych wersjach.

---

## Licencja

Do użytku własnego i społeczności edytorów Waze.  