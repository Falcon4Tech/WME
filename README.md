# Userskrypty Waze (WME)

Repozytorium zawiera **userskrypty do Waze Map Editor (WME)**.  
Każdy userskrypt znajduje się w **osobnym podfolderze** i jest rozwijany niezależnie.

Skrypty są pisane z myślą o:
- integracjach z zewnętrznymi źródłami danych (WMS / GeoJSON),
- ułatwieniu pracy edytorom WME,
- zachowaniu kompatybilności z aktualnym UI i SDK WME.

---

## Struktura repozytorium
```
/
├─ nazwa-skryptu-1/
│  ├─ xxx.user.js   # właściwy userscript
│  ├─ xxx.meta.js   # plik meta (nagłówek do auto-update)
│  └─ README.md     # opis konkretnego skryptu
│
├─ nazwa-skryptu-2/
│  ├─ …
│
└─ README.md        # ten plik
```

### Zasady
- **Źródłem prawdy jest plik `*.user.js`**
- Plik `*.meta.js` zawiera **wyłącznie nagłówek userscripta**
- Każdy skrypt:
  - ma własny folder,
  - może mieć własne README,
  - nie zależy bezpośrednio od innych skryptów w repo.

---

## Instalacja userskryptów

1. Zainstaluj menedżer userskryptów:
   - Tampermonkey (Chrome / Firefox)
   - Violentmonkey

2. Wejdź do folderu interesującego Cię skryptu
3. Zainstaluj plik `*.user.js`
4. (Opcjonalnie) `*.meta.js` służy do aktualizacji — **nie instaluj go ręcznie**

---

## Aktualizacje

Skrypty są przygotowane pod mechanizm auto-update:
- Tampermonkey pobiera `*.meta.js`
- właściwy kod ładowany jest z `*.user.js`

---

## Status projektu

Repo jest **aktywnie rozwijane**.  
Kod może się zmieniać wraz z aktualizacjami WME.

Jeżeli coś przestaje działać po update Waze — to normalne 🙂  
Poprawki pojawiają się sukcesywnie.

---

## Licencja

Do użytku własnego i społeczności edytorów Waze.  
