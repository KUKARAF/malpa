# malpa 🐒

Rozszerzenie Chrome zasilane przez AI, które generuje i zarządza userscriptami. Opisz co chcesz zmienić na stronie, a malpa napisze, zapisze i automatycznie wstrzyknie skrypt — tak jak Violentmonkey, tylko że kod pisze za Ciebie AI.

## Jak działa

1. Otwórz rozszerzenie na dowolnej stronie
2. Opisz zmianę po polsku lub angielsku (np. _„spraw, żeby pasek wyszukiwania był zielony"_)
3. AI analizuje żywy DOM strony i generuje skrypt
4. Skrypt zostaje zapisany i automatycznie uruchamiany przy każdym kolejnym wejściu na tę stronę

## Wymagania

- Chrome 120+
- Konto na [OpenRouter](https://openrouter.ai) (klucz API)
- Włączony **Developer Mode** w `chrome://extensions`
- Włączony przełącznik **Allow User Scripts** na stronie szczegółów rozszerzenia

## Instalacja

### Ze źródeł

```bash
git clone https://github.com/kukaraf/malpa.git
```

1. Otwórz `chrome://extensions`
2. Włącz **Developer Mode** (prawy górny róg)
3. Kliknij **Load unpacked** i wskaż folder repozytorium
4. Wejdź w **Details → Allow User Scripts**

### Z release

Pobierz `malpa.zip` z [zakładki Releases](https://github.com/kukaraf/malpa/releases), rozpakuj i załaduj rozpakowany folder przez **Load unpacked**.

## Konfiguracja

Kliknij prawym przyciskiem ikonę rozszerzenia → **Options** i wpisz:

| Ustawienie | Opis | Domyślnie |
|---|---|---|
| OpenRouter API Key | Klucz API z openrouter.ai | — |
| Model | Dowolny model dostępny na OpenRouter | `anthropic/claude-sonnet-4-5` |
| Max iteracji | Ile kroków może wykonać agent | `10` |
| Rozmiar DOM (bajty) | Limit podglądu DOM wysyłanego do AI | `150000` |

## Funkcje

- **Generowanie skryptów** — AI czyta żywy DOM i pisze skrypt dopasowany do konkretnych selektorów
- **Edycja przez AI** — otwórz Dashboard, kliknij „Edit via AI" i opisz zmianę
- **Dashboard** — lista skryptów z podglądem kodu, włączaniem/wyłączaniem i usuwaniem
- **Logi wykonania** — zakładka Logs pokazuje kiedy i na jakiej stronie skrypt się uruchomił
- **Licznik na ikonie** — pokazuje ile skryptów jest aktywnych na bieżącej stronie (jak Violentmonkey)

## Struktura projektu

```
malpa/
├── manifest.json       # konfiguracja rozszerzenia (MV3)
├── background.js       # service worker — pętla agenta, rejestracja skryptów
├── content.js          # ekstraktor DOM
├── popup.html/js       # okienko rozszerzenia
├── dashboard.html/js   # menedżer skryptów i logi
├── settings.html/js    # konfiguracja klucza API
└── icons/
```

## Technologie

- **Manifest V3** — zgodność z nowoczesnymi wymaganiami Chrome
- **`chrome.userScripts` API** — trwała rejestracja skryptów w świecie `USER_SCRIPT`
- **OpenRouter** — zunifikowane API do modeli AI (domyślnie Claude Sonnet)
- Żadnych zewnętrznych zależności — czyste HTML/CSS/JS

## Licencja

MIT
