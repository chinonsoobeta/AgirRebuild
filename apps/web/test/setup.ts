// Loads every strings table before each test file, as if every screen had been opened: the app loads a screen's
// strings with its route group (card I), and the web tests expect all of them. Only the strings modules are loaded.
import "../src/strings/shell";
import "../src/strings/deals";
import "../src/strings/newdeal";
import "../src/strings/quickstart";
import "../src/strings/documents";
import "../src/strings/review";
import "../src/strings/run";
import "../src/strings/decision";
import "../src/strings/reports";
import "../src/strings/explore";
import "../src/strings/audit";
import "../src/strings/compare";
import "../src/strings/settings";
import "../src/strings/auth";
import "../src/strings/landing";
import "../src/strings/agirreview";
import "../src/strings/share";
import "../src/strings/thresholds";
import "../src/strings/terms";
