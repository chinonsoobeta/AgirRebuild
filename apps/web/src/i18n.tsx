// English and French (Canada). Interface strings live here; so do the French
// labels for every field, metric, stress and gate in @agir/contracts, and the
// French forms of the messages the engine and the API produce. Numbers follow
// the language: 51,962,556 and 6.45% in English, 51 962 556 $ and 6,45 % in French.

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { CURRENCY_NAMES, FIELD_BY_KEY, METRIC_BY_KEY, placeLabel, type Currency } from "@agir/contracts";

export type Lang = "en" | "fr";

// ---- Interface strings -------------------------------------------------------------------
type Entry = string | ((p: Record<string, any>) => string | string[]);
const s = (n: number, one: string, many: string) => (n === 1 ? one : many);

const EN = {
  "nav.deals": "Deals",
  "nav.settings": "Settings",
  "nav.signOut": "Sign out",
  "nav.language": "Français",
  "common.loading": "Loading…",
  "common.cancel": "Cancel",
  "common.save": "Save",
  "common.download": "Download",
  "common.open": "Open",
  "common.notMeaningful": "Not meaningful",
  "common.notApplicable": "Not applicable",
  "common.notMeasured": "Not measured",
  "common.yes": "Yes",
  "common.no": "No",
  "common.workspace": "Workspace",
  "common.material": "Material",
  "common.run": (p) => `Run ${p.n}`,

  "auth.pitch": "Every number traces to a document, a decision, or a named default.",
  "auth.pitchBody": "Agir turns a development deal package into an investment-committee decision. It reads the documents, asks you to approve what it found, and refuses to run when an input is missing or two documents disagree.",
  "auth.signIn": "Sign in",
  "auth.signingIn": "Signing in…",
  "auth.email": "Email",
  "auth.password": "Password",
  "auth.name": "Name",
  "auth.createAccount": "Create an account",
  "auth.create": "Create account",
  "auth.haveAccount": "I have an account",
  "auth.passwordHelp": "At least 10 characters.",
  "auth.demo": "Local demo",
  "auth.demoAnalyst": "Continue as Dana Analyst",
  "auth.demoReviewer": "Continue as Rowan Reviewer",
  "auth.demoHelp": "Development only. Rowan is a second admin, so you can try dual control and committee decisions.",

  "deals.title": "Deals",
  "deals.none": "No deals yet.",
  "deals.summary": (p) => `${p.blocked} ${s(p.blocked, "deal is", "deals are")} blocked. ${p.ready} ${s(p.ready, "is", "are")} ready for a committee decision.`,
  "deals.search": "Search deals",
  "deals.new": "New deal",
  "deals.filter": "Filter deals",
  "deals.f.all": "All",
  "deals.f.blocked": "Blocked",
  "deals.f.decide": "Ready to decide",
  "deals.f.progress": "In progress",
  "deals.f.decided": "Decided",
  "deals.col.deal": "Deal",
  "deals.col.step": "Step",
  "deals.col.status": "Status",
  "deals.col.next": "Next action",
  "deals.docs": (p) => `${p.n} ${s(p.n, "document", "documents")}`,
  "deals.empty": "Create a deal, then upload its documents.",
  "deals.noMatch": "No deals match.",
  "deals.evidence": "A deal's step comes from its evidence: documents, approved inputs, a current run, a recorded decision. Nobody sets it by hand.",
  "deals.name": "Name",
  "deals.assetType": "Asset type",
  "deals.location": "Location",
  "deals.locationHint": "City (and state, outside Canada)",
  "deals.country": "Country",
  "deals.country.CA": "Canada",
  "deals.country.US": "United States",
  "deals.province": "Province or territory",
  "deals.provinceChoose": "Choose one",
  "deals.currency": "Currency",
  "deals.currencyHint": "Every amount in this deal is in this currency. It is set now and cannot be changed later.",
  "deals.currencyNone": "Currency not stated",
  "deals.create": "Create deal",

  "step.documents": "Documents",
  "step.review": "Review",
  "step.run": "Run",
  "step.decision": "Decision",
  "step.reports": "Reports",
  "step.steps": "Deal steps",
  "step.audit": "Audit trail",
  "step.noDocs": "No documents",
  "step.reading": (p) => `Reading ${p.n}`,
  "step.read": (p) => `${p.n} read${p.failed ? `, ${p.failed} failed` : ""}`,
  "step.waitingDocs": "Waiting for documents",
  "step.clear": "Clear",
  "step.readyToRun": "Ready to run",
  "step.locked": "Locked until review is clear",
  "step.runState": (p) => `Run ${p.n} · ${p.state}`,
  "step.outOfDate": "out of date",
  "step.notRecorded": "Not recorded",
  "step.waiting": "Waiting",
  "step.ready": (p) => `${p.n} ready`,
  "step.noneYet": "None yet",

  "status.noDocs": "No documents yet",
  "status.reading": (p) => `Reading ${p.n} ${s(p.n, "document", "documents")}`,
  "status.blocked": "Blocked",
  "status.conflicts": (p) => `${p.n} ${s(p.n, "conflict", "conflicts")}`,
  "status.missing": (p) => `${p.n} missing`,
  "status.toReview": (p) => `${p.n} to review`,
  "status.awaiting": (p) => `${p.n} awaiting a second approver`,
  "status.outOfRange": (p) => `${p.n} out of range`,
  "status.outOfDate": "Results are out of date",
  "status.readyToRun": "Ready to run",
  "status.verdict": (p) => `Verdict: ${p.v}`,
  "status.decided": (p) => `Decided: ${p.d}`,
  "next.upload": "Upload the deal documents",
  "next.retry": (p) => `Retry ${p.n} failed ${s(p.n, "document", "documents")}`,
  "next.wait": "Wait for extraction",
  "next.resolve": (p) => `Resolve ${p.n} ${s(p.n, "conflict", "conflicts")}`,
  "next.enter": (p) => `Enter ${p.n} missing ${s(p.n, "input", "inputs")}`,
  "next.review": "Review the extracted values",
  "next.run": "Run underwriting",
  "next.decide": "Record the committee decision",
  "next.share": "Share the reports",
  "next.memo": "Generate the IC memo",

  "docs.drop": "Drop deal documents here",
  "docs.types": "PDF, Excel, CSV, Word or text · up to 75 MB each · every file is checked before it is read",
  "docs.choose": "Choose files",
  "docs.uploading": "Uploading…",
  "docs.duplicate": (p) => `${p.name} is already in this deal, so it was not added twice.`,
  "docs.col.doc": "Document",
  "docs.col.stages": "Checked · Read · Values",
  "docs.col.result": "Result",
  "docs.actions": "Actions",
  "docs.pages": (p) => `${p.n} ${s(p.n, "page", "pages")}`,
  "docs.noValues": "No underwriting values in this document",
  "docs.values": (p) => `${p.n} values found`,
  "docs.other": (p) => `${p.n} other figures kept but not used`,
  "docs.format": (p) => `Numbers written as ${p.f}: check each value`,
  "docs.unusable": "This file could not be used.",
  "docs.stage.uploaded": "Waiting to be checked",
  "docs.stage.checking": "Checking the file",
  "docs.stage.reading": "Reading",
  "docs.stage.extracting": "Finding values",
  "docs.retry": "Retry",
  "docs.remove": "Remove",
  "docs.removeConfirm": (p) => `Remove ${p.name} from this deal? Values found only in it go back to review.`,
  "docs.empty": "No documents yet. Upload the sponsor summary, budget, rent roll, term sheet and appraisal.",
  "docs.what": "What happens to a file",
  "docs.what1": "Checked.",
  "docs.what1b": "Type, size and fingerprint. A file that is not what its name says is rejected.",
  "docs.what2": "Read.",
  "docs.what2b": "Text and tables, with the page, line or cell each value came from.",
  "docs.what3": "Values found.",
  "docs.what3b": "Numbers matched to the fields Agir underwrites. A number that could be read two ways is not read at all.",
  "docs.candidates": "Values found are only candidates. Nothing reaches underwriting until someone approves it in Review.",

  "review.stillReading": "Documents are still being read.",
  "review.stillReadingBody": "Values will appear here as each one finishes.",
  "review.summary": (p) => [`${p.c} conflicting`, `${p.m} missing`, `${p.r} to review`, `${p.a} approved`],
  "review.blocked": "Underwriting is blocked.",
  "review.b.conflicts": (p) => `${p.n} ${s(p.n, "input has", "inputs have")} documents that disagree`,
  "review.b.missing": (p) => `${p.n} required ${s(p.n, "input is", "inputs are")} missing`,
  "review.b.pending": (p) => `${p.n} extracted ${s(p.n, "value needs", "values need")} review`,
  "review.b.awaiting": (p) => `${p.n} ${s(p.n, "override is", "overrides are")} waiting for a second approver`,
  "review.b.impossible": (p) => `${p.n} ${s(p.n, "value is", "values are")} out of range`,
  "review.b.tail": ". Agir will not choose or fill in a value for you.",
  "review.clear": "Review is clear.",
  "review.clearBody": "Every required input is approved or a named default. Go to Run.",
  "review.needsDecision": "Needs a decision",
  "review.conflicting": "Conflicting",
  "review.conservative": " · the conservative value",
  "review.choosingNote": (p) => `Choosing a documented value needs no second approver. Entering a different one ${p.material ? "does" : "needs a reason"}.`,
  "review.enterDifferent": "Enter a different value",
  "review.choose": "Choose a value",
  "review.resolveWith": (p) => `Resolve with ${p.v}`,
  "review.differentValue": "Different value",
  "review.why": "Why (recorded in the audit trail)",
  "review.whyHint": "Where does this value come from?",
  "review.materialNote": "Material field: a second, different person must confirm this value before it counts.",
  "review.saveValue": "Save value",
  "review.missing": "Missing inputs",
  "review.nMissing": (p) => `${p.n} missing`,
  "review.acceptDefaults": (p) => `Accept ${p.n} ${s(p.n, "default", "defaults")}`,
  "review.missingBody": (p) => `No document states these. Enter each value and say where it comes from${p.defaults ? ", or accept the named defaults, which every report will disclose" : ""}.`,
  "review.default": (p) => ` · default ${p.v}`,
  "review.materialTag": " · material",
  "review.sourceFor": (p) => `Source for ${p.label}`,
  "review.sourceHint": "Source or reason, e.g. sponsor call on Sept 12",
  "review.awaiting": "Waiting for a second approver",
  "review.enteredBy": (p) => `entered by ${p.who}${p.old ? `, replacing ${p.old}` : ""}`,
  "review.reason": (p) => `Reason: ${p.r}`,
  "review.confirm": "Confirm as second approver",
  "review.decline": "Decline",
  "review.mine": "You entered this value, so someone else must confirm it.",
  "review.needsReview": "Needs review",
  "review.approveAll": (p) => `Approve all ${p.n}`,
  "review.approveAllConfirm": (p) => `Approve all ${p.n} values as extracted? Each keeps its source and your name in the audit trail.`,
  "review.col.input": "Input",
  "review.col.value": "Value",
  "review.col.source": "Source",
  "review.agree": (p) => `${p.n} documents agree`,
  "review.approve": "Approve",
  "review.edit": "Edit",
  "review.reject": "Reject",
  "review.approved": "Approved",
  "review.defaultAccepted": "Default accepted",
  "review.enteredByShort": (p) => `Entered by ${p.who}`,
  "review.confirmedBy": (p) => ` · confirmed by ${p.who}`,
  "review.reopen": "Reopen",
  "review.rejected": "Rejected",
  "review.other": "Figures in the documents that Agir did not use",
  "review.otherBody": "Shown so nothing is hidden. Output figures such as a broker's projected NOI are never taken as inputs, and a number that could be read two ways is not read at all.",
  "review.col.doc": "Document",
  "review.col.text": "Text",
  "review.col.whyNot": "Why it was not used",
  "review.where": "Where each value came from",
  "review.namedDefault": "A named default, accepted explicitly.",
  "review.selectValue": "Select a value to see the line it was read from.",
  "review.recorded": "Every action is recorded",
  "review.recordedBody": "Your choice, its sources and your name go into the audit trail. A value that changes after a run makes that run out of date.",
  "review.sourceReason": "Source or reason",
  "review.revenueProgram": "Revenue program (at least one unit type or space)",
  "review.enterNumber": "Enter a number.",
  "review.rejectedInReview": "Rejected in review",
  "review.declined": "Second approver declined",

  "run.noRun": "No run yet",
  "run.noRunBody": "A run reads only the approved inputs, builds one monthly ledger, re-runs it under six stresses and a combined stress, and records a verdict you can reproduce exactly.",
  "run.run": "Run underwriting",
  "run.running": "Running…",
  "run.again": "Run again",
  "run.blockedWhy": (p) => `Blocked until review is clear: ${p.why}.`,
  "run.viewerWhy": "Viewers can read results but not run underwriting.",
  "run.loading": "Loading the run…",
  "run.outOfDate": (p) => `Run ${p.n} is out of date.`,
  "run.outOfDateBody": "Its figures are shown as they were; run again before deciding.",
  "run.verdictLabel": (p) => `Verdict · Run ${p.n} · ${p.policy}`,
  "run.memo": "Generate IC memo",
  "run.decide": "Record decision",
  "run.explore": "Explore changes",
  "run.gates": "Gates",
  "run.col.gate": "Gate",
  "run.col.needs": "Needs",
  "run.col.result": "Result",
  "run.col.outcome": "Outcome",
  "run.passes": "Passes",
  "run.fails": "Fails",
  "run.notEvaluated": "Not evaluated",
  "run.gatesNote": "Gate results are stored with the run. The memo and every report read these rows; nothing recomputes them.",
  "run.stresses": "Stresses",
  "run.col.scenario": "Scenario",
  "run.readByGates": " · read by the gates",
  "run.annual": "Annual cash flows",
  "run.col.period": "Period",
  "run.col.egi": "EGI",
  "run.col.opex": "Operating costs",
  "run.col.noi": "NOI",
  "run.col.ds": "Debt service",
  "run.col.cf": "Cash flow",
  "run.beforeStab": "Before stabilization",
  "run.year": (p) => `Year ${p.n}`,
  "run.howMade": (p) => `How ${p.label} was made`,
  "run.keyFigures": "Key figures",
  "run.selectFigure": "Select a figure to see its formula.",
  "run.checks": "Checks",
  "run.pass": "Pass",
  "run.check": "Check",
  "run.record": "Run record",
  "run.current": "Current · inputs unchanged since this run",
  "run.stale": "Out of date",
  "run.recordLine": (p) => `Run ${p.n} · engine ${p.engine} · ${p.policy}`,
  "run.hashes": (p) => `inputs ${p.i} · result ${p.r}`,
  "run.signed": (p) => `signed with the ${p.key}`,
  "run.devKey": "development key",
  "run.prodKey": "production key",
  "run.package": "Download audit package",
  "run.inputs": "Inputs this run used",
  "run.history": "Run history",
  "run.stale.inputs": "An approved input changed after this run.",
  "run.stale.policy": "The policy thresholds changed after this run.",
  "run.stale.engine": "The engine was updated after this run.",

  "explore.title": "Explore changes",
  "explore.banner": "Exploration, not a run.",
  "explore.bannerBody": (p) => `Every figure here is a re-run of run ${p.n} with your changes. Nothing is saved, and none of it can be exported or decided on.`,
  "explore.noRun": "Explore needs a run to start from.",
  "explore.drivers": "Change the assumptions",
  "explore.reset": "Reset",
  "explore.results": "What changes",
  "explore.col.metric": "Figure",
  "explore.col.run": "Run",
  "explore.col.explored": "Explored",
  "explore.col.change": "Change",
  "explore.verdictNow": "Verdict with these changes",
  "explore.tornado": "Which assumptions matter most",
  "explore.tornadoBody": "Each bar moves one assumption down and up by the amount shown, holding everything else at the run's values.",
  "explore.metric": "Figure",
  "explore.base": (p) => `Run value ${p.v}`,
  "explore.lowers": "Moves the figure down",
  "explore.raises": "Moves the figure up",
  "explore.grid": "Two assumptions at once",
  "explore.gridBody": (p) => `Cells marked as failing are below ${p.t}.`,
  "explore.gridBodyNone": "Each cell is a re-run with both changes applied.",
  "explore.across": "Across",
  "explore.down": "Down",
  "explore.belowGate": "Below the threshold",
  "explore.table": "Show as a table",
  "explore.unchanged": "unchanged",
  "explore.working": "Working…",

  "decision.noRun": "There is no run to decide on yet.",
  "decision.noRunBody": "A committee decision is always recorded against a specific run.",
  "decision.goRun": "Go to Run",
  "decision.recorded": "Recorded decisions",
  "decision.conditions": (p) => `Conditions: ${p.c}`,
  "decision.against": (p) => `Decided against the ${p.v} verdict because: ${p.r}`,
  "decision.permanent": "permanent record",
  "decision.cannot": "A decision cannot be recorded right now.",
  "decision.stale": "The inputs changed after this run. Run underwriting again first.",
  "decision.role": "Only a workspace admin or owner records committee decisions.",
  "decision.further": "Record a further decision",
  "decision.title": "Committee decision",
  "decision.reasoning": "The committee's reasoning",
  "decision.conditionsLabel": "Conditions",
  "decision.overrideLabel": (p) => `Why approve against a ${p.v} verdict`,
  "decision.overrideHelp": "Required. It is recorded with the decision and shown in every report.",
  "decision.record": "Record decision",
  "decision.permanentNote": "Decisions are permanent. A later decision is added, never edited.",
  "decision.binds": "What a decision binds to",
  "decision.bindsBody": (p) => `This decision names run ${p.n}: its exact inputs, engine version and policy. If an input changes afterwards, the run goes out of date and a new decision needs a new run.`,

  "reports.needRun": "Reports are built from a run.",
  "reports.needRunBody": "Run underwriting first; every figure in a report comes from that run.",
  "reports.stale": (p) => `Run ${p.n} is out of date.`,
  "reports.staleBody": "Reports from it still show its figures as they were, labelled with the run number.",
  "reports.generate": (p) => `Generate from run ${p.n}`,
  "reports.memo": "IC memo",
  "reports.lender": "Lender package",
  "reports.model": "Model",
  "reports.modelExport": "Model export",
  "reports.word": "Word",
  "reports.excel": "Excel",
  "reports.package": "Audit package",
  "reports.note": "Every number in a memo is printed from the run with its source recorded. Before a file is released, a scan checks that no figure lacks one; if any does, the file is blocked.",
  "reports.memoLang": "Memos and reports are written in English.",
  "reports.col.report": "Report",
  "reports.col.status": "Status",
  "reports.col.created": "Created",
  "reports.ready": "Ready",
  "reports.traced": (p) => ` · ${p.n} figures traced`,
  "reports.rendering": "Rendering",
  "reports.blocked": "Blocked",
  "reports.failed": "Failed",
  "reports.none": "No reports yet.",

  "audit.title": "Audit trail",
  "audit.body": "Every event is chained to the one before it by a hash. Nothing in this list can be edited or deleted.",
  "audit.intact": (p) => `Chain intact · ${p.n} events`,
  "audit.broken": (p) => `Chain broken at event ${p.n}`,
  "audit.verify": "Verify the chain",
  "audit.col.event": "Event",
  "audit.col.who": "Who",
  "audit.col.when": "When",
  "audit.col.hash": "Hash",
  "audit.worker": "Agir worker",

  "settings.title": "Settings",
  "settings.role": (p) => `${p.ws} · your role: ${p.role}`,
  "settings.people": "People in this workspace",
  "settings.col.name": "Name",
  "settings.col.email": "Email",
  "settings.col.role": "Role",
  "settings.add": "Add someone who already has an account",
  "settings.addBtn": "Add",
  "settings.roles": "What each role can do",
  "settings.r.viewer": "Reads every deal, run, report and the audit trail.",
  "settings.r.analyst": "Uploads documents, reviews values, runs underwriting, generates reports.",
  "settings.r.admin": "Everything an analyst can do, plus committee decisions and adding people.",
  "settings.r.owner": "Everything an admin can do. Created the workspace.",
  "settings.newWs": "New workspace",
  "settings.create": "Create",
  "settings.language": "Language",
  "settings.languageBody": "The interface and its numbers follow this choice. It is remembered on this device.",
} satisfies Record<string, Entry>;

export type Key = keyof typeof EN;

const FR: Record<Key, Entry> = {
  "nav.deals": "Projets",
  "nav.settings": "Paramètres",
  "nav.signOut": "Se déconnecter",
  "nav.language": "English",
  "common.loading": "Chargement…",
  "common.cancel": "Annuler",
  "common.save": "Enregistrer",
  "common.download": "Télécharger",
  "common.open": "Ouvrir",
  "common.notMeaningful": "Non significatif",
  "common.notApplicable": "Sans objet",
  "common.notMeasured": "Non mesuré",
  "common.yes": "Oui",
  "common.no": "Non",
  "common.workspace": "Espace de travail",
  "common.material": "Déterminant",
  "common.run": (p) => `Analyse ${p.n}`,

  "auth.pitch": "Chaque chiffre renvoie à un document, à une décision ou à une valeur par défaut nommée.",
  "auth.pitchBody": "Agir mène un dossier de projet immobilier jusqu'à la décision du comité d'investissement. Il lit les documents, vous demande d'approuver ce qu'il a trouvé et refuse de calculer lorsqu'une donnée manque ou que deux documents se contredisent.",
  "auth.signIn": "Se connecter",
  "auth.signingIn": "Connexion…",
  "auth.email": "Courriel",
  "auth.password": "Mot de passe",
  "auth.name": "Nom",
  "auth.createAccount": "Créer un compte",
  "auth.create": "Créer le compte",
  "auth.haveAccount": "J'ai déjà un compte",
  "auth.passwordHelp": "Au moins 10 caractères.",
  "auth.demo": "Démo locale",
  "auth.demoAnalyst": "Continuer en tant que Dana Analyst",
  "auth.demoReviewer": "Continuer en tant que Rowan Reviewer",
  "auth.demoHelp": "Développement seulement. Rowan est un second administrateur : vous pouvez essayer la double validation et les décisions du comité.",

  "deals.title": "Projets",
  "deals.none": "Aucun projet pour l'instant.",
  "deals.summary": (p) => `${p.blocked} ${s(p.blocked, "projet est bloqué", "projets sont bloqués")}. ${p.ready} ${s(p.ready, "est prêt", "sont prêts")} pour une décision du comité.`,
  "deals.search": "Rechercher un projet",
  "deals.new": "Nouveau projet",
  "deals.filter": "Filtrer les projets",
  "deals.f.all": "Tous",
  "deals.f.blocked": "Bloqués",
  "deals.f.decide": "Prêts pour décision",
  "deals.f.progress": "En cours",
  "deals.f.decided": "Décidés",
  "deals.col.deal": "Projet",
  "deals.col.step": "Étape",
  "deals.col.status": "Statut",
  "deals.col.next": "Prochaine action",
  "deals.docs": (p) => `${p.n} ${s(p.n, "document", "documents")}`,
  "deals.empty": "Créez un projet, puis téléversez ses documents.",
  "deals.noMatch": "Aucun projet ne correspond.",
  "deals.evidence": "L'étape d'un projet découle de ses preuves : documents, données approuvées, analyse à jour, décision consignée. Personne ne la fixe à la main.",
  "deals.name": "Nom",
  "deals.assetType": "Type d'actif",
  "deals.location": "Emplacement",
  "deals.locationHint": "Ville (et État, hors du Canada)",
  "deals.country": "Pays",
  "deals.country.CA": "Canada",
  "deals.country.US": "États-Unis",
  "deals.province": "Province ou territoire",
  "deals.provinceChoose": "Choisissez-en une",
  "deals.currency": "Devise",
  "deals.currencyHint": "Tous les montants de ce projet sont dans cette devise. Elle est fixée maintenant et ne peut plus être modifiée.",
  "deals.currencyNone": "Devise non indiquée",
  "deals.create": "Créer le projet",

  "step.documents": "Documents",
  "step.review": "Examen",
  "step.run": "Analyse",
  "step.decision": "Décision",
  "step.reports": "Rapports",
  "step.steps": "Étapes du projet",
  "step.audit": "Piste d'audit",
  "step.noDocs": "Aucun document",
  "step.reading": (p) => `Lecture de ${p.n}`,
  "step.read": (p) => `${p.n} ${s(p.n, "lu", "lus")}${p.failed ? `, ${p.failed} en échec` : ""}`,
  "step.waitingDocs": "En attente des documents",
  "step.clear": "Terminé",
  "step.readyToRun": "Prêt à lancer",
  "step.locked": "Bloqué jusqu'à la fin de l'examen",
  "step.runState": (p) => `Analyse ${p.n} · ${p.state}`,
  "step.outOfDate": "périmée",
  "step.notRecorded": "Non consignée",
  "step.waiting": "En attente",
  "step.ready": (p) => `${p.n} ${s(p.n, "prêt", "prêts")}`,
  "step.noneYet": "Aucun pour l'instant",

  "status.noDocs": "Aucun document pour l'instant",
  "status.reading": (p) => `Lecture de ${p.n} ${s(p.n, "document", "documents")}`,
  "status.blocked": "Bloqué",
  "status.conflicts": (p) => `${p.n} ${s(p.n, "conflit", "conflits")}`,
  "status.missing": (p) => `${p.n} ${s(p.n, "manquante", "manquantes")}`,
  "status.toReview": (p) => `${p.n} à examiner`,
  "status.awaiting": (p) => `${p.n} en attente d'un second approbateur`,
  "status.outOfRange": (p) => `${p.n} hors limites`,
  "status.outOfDate": "Les résultats sont périmés",
  "status.readyToRun": "Prêt à lancer",
  "status.verdict": (p) => `Verdict : ${p.v}`,
  "status.decided": (p) => `Décidé : ${p.d}`,
  "next.upload": "Téléverser les documents du projet",
  "next.retry": (p) => `Relancer ${p.n} ${s(p.n, "document en échec", "documents en échec")}`,
  "next.wait": "Attendre l'extraction",
  "next.resolve": (p) => `Résoudre ${p.n} ${s(p.n, "conflit", "conflits")}`,
  "next.enter": (p) => `Saisir ${p.n} ${s(p.n, "donnée manquante", "données manquantes")}`,
  "next.review": "Examiner les valeurs extraites",
  "next.run": "Lancer l'analyse",
  "next.decide": "Consigner la décision du comité",
  "next.share": "Partager les rapports",
  "next.memo": "Générer le mémo du comité",

  "docs.drop": "Déposez les documents du projet ici",
  "docs.types": "PDF, Excel, CSV, Word ou texte · jusqu'à 75 Mo chacun · chaque fichier est vérifié avant d'être lu",
  "docs.choose": "Choisir des fichiers",
  "docs.uploading": "Téléversement…",
  "docs.duplicate": (p) => `${p.name} figure déjà dans ce projet ; il n'a pas été ajouté une seconde fois.`,
  "docs.col.doc": "Document",
  "docs.col.stages": "Vérifié · Lu · Valeurs",
  "docs.col.result": "Résultat",
  "docs.actions": "Actions",
  "docs.pages": (p) => `${p.n} ${s(p.n, "page", "pages")}`,
  "docs.noValues": "Aucune valeur d'analyse dans ce document",
  "docs.values": (p) => `${p.n} ${s(p.n, "valeur trouvée", "valeurs trouvées")}`,
  "docs.other": (p) => `${p.n} autres chiffres conservés mais non utilisés`,
  "docs.format": (p) => `Nombres écrits sous la forme ${p.f} : vérifiez chaque valeur`,
  "docs.unusable": "Ce fichier n'a pas pu être utilisé.",
  "docs.stage.uploaded": "En attente de vérification",
  "docs.stage.checking": "Vérification du fichier",
  "docs.stage.reading": "Lecture",
  "docs.stage.extracting": "Recherche des valeurs",
  "docs.retry": "Relancer",
  "docs.remove": "Retirer",
  "docs.removeConfirm": (p) => `Retirer ${p.name} de ce projet ? Les valeurs trouvées uniquement dans ce document retournent à l'examen.`,
  "docs.empty": "Aucun document. Téléversez le sommaire du promoteur, le budget, le rôle des loyers, la lettre d'engagement et l'évaluation.",
  "docs.what": "Ce qui arrive à un fichier",
  "docs.what1": "Vérifié.",
  "docs.what1b": "Type, taille et empreinte. Un fichier qui n'est pas ce que son nom indique est refusé.",
  "docs.what2": "Lu.",
  "docs.what2b": "Texte et tableaux, avec la page, la ligne ou la cellule d'où vient chaque valeur.",
  "docs.what3": "Valeurs trouvées.",
  "docs.what3b": "Nombres associés aux champs qu'Agir analyse. Un nombre qui peut se lire de deux façons n'est pas lu du tout.",
  "docs.candidates": "Les valeurs trouvées ne sont que des candidates. Rien n'entre dans l'analyse avant d'avoir été approuvé à l'étape Examen.",

  "review.stillReading": "Des documents sont encore en lecture.",
  "review.stillReadingBody": "Les valeurs apparaîtront ici à mesure que chaque document est terminé.",
  "review.summary": (p) => [
    `${p.c} en conflit`,
    `${p.m} ${s(p.m, "manquante", "manquantes")}`,
    `${p.r} à examiner`,
    `${p.a} ${s(p.a, "approuvée", "approuvées")}`,
  ],
  "review.blocked": "L'analyse est bloquée.",
  "review.b.conflicts": (p) => `${p.n} ${s(p.n, "donnée a des documents qui se contredisent", "données ont des documents qui se contredisent")}`,
  "review.b.missing": (p) => `${p.n} ${s(p.n, "donnée requise manque", "données requises manquent")}`,
  "review.b.pending": (p) => `${p.n} ${s(p.n, "valeur extraite doit être examinée", "valeurs extraites doivent être examinées")}`,
  "review.b.awaiting": (p) => `${p.n} ${s(p.n, "dérogation attend", "dérogations attendent")} un second approbateur`,
  "review.b.impossible": (p) => `${p.n} ${s(p.n, "valeur est", "valeurs sont")} hors limites`,
  "review.b.tail": ". Agir ne choisira ni ne complétera aucune valeur à votre place.",
  "review.clear": "L'examen est terminé.",
  "review.clearBody": "Chaque donnée requise est approuvée ou constitue une valeur par défaut nommée. Passez à l'analyse.",
  "review.needsDecision": "Décisions à prendre",
  "review.conflicting": "En conflit",
  "review.conservative": " · la valeur prudente",
  "review.choosingNote": (p) =>
    `Choisir une valeur documentée ne requiert pas de second approbateur. En saisir une autre ${p.material ? "en requiert un" : "exige une justification"}.`,
  "review.enterDifferent": "Saisir une autre valeur",
  "review.choose": "Choisir une valeur",
  "review.resolveWith": (p) => `Résoudre avec ${p.v}`,
  "review.differentValue": "Autre valeur",
  "review.why": "Justification (consignée dans la piste d'audit)",
  "review.whyHint": "D'où vient cette valeur ?",
  "review.materialNote": "Champ déterminant : une seconde personne, différente, doit confirmer cette valeur avant qu'elle compte.",
  "review.saveValue": "Enregistrer la valeur",
  "review.missing": "Données manquantes",
  "review.nMissing": (p) => `${p.n} ${s(p.n, "manquante", "manquantes")}`,
  "review.acceptDefaults": (p) => `Accepter ${p.n} ${s(p.n, "valeur par défaut", "valeurs par défaut")}`,
  "review.missingBody": (p) =>
    `Aucun document ne les indique. Saisissez chaque valeur et précisez sa provenance${p.defaults ? ", ou acceptez les valeurs par défaut nommées, que chaque rapport divulguera" : ""}.`,
  "review.default": (p) => ` · par défaut ${p.v}`,
  "review.materialTag": " · déterminant",
  "review.sourceFor": (p) => `Source de ${p.label}`,
  "review.sourceHint": "Source ou justification, p. ex. appel avec le promoteur le 12 sept.",
  "review.awaiting": "En attente d'un second approbateur",
  "review.enteredBy": (p) => `saisie par ${p.who}${p.old ? `, en remplacement de ${p.old}` : ""}`,
  "review.reason": (p) => `Justification : ${p.r}`,
  "review.confirm": "Confirmer comme second approbateur",
  "review.decline": "Refuser",
  "review.mine": "Vous avez saisi cette valeur ; une autre personne doit la confirmer.",
  "review.needsReview": "À examiner",
  "review.approveAll": (p) => `Tout approuver (${p.n})`,
  "review.approveAllConfirm": (p) => `Approuver les ${p.n} valeurs telles qu'extraites ? Chacune conserve sa source et votre nom dans la piste d'audit.`,
  "review.col.input": "Donnée",
  "review.col.value": "Valeur",
  "review.col.source": "Source",
  "review.agree": (p) => `${p.n} documents concordent`,
  "review.approve": "Approuver",
  "review.edit": "Modifier",
  "review.reject": "Rejeter",
  "review.approved": "Approuvées",
  "review.defaultAccepted": "Valeur par défaut acceptée",
  "review.enteredByShort": (p) => `Saisie par ${p.who}`,
  "review.confirmedBy": (p) => ` · confirmée par ${p.who}`,
  "review.reopen": "Rouvrir",
  "review.rejected": "Rejetées",
  "review.other": "Chiffres des documents qu'Agir n'a pas utilisés",
  "review.otherBody": "Affichés pour que rien ne soit caché. Les résultats, comme le RNE projeté d'un courtier, ne sont jamais retenus comme données, et un nombre qui peut se lire de deux façons n'est pas lu du tout.",
  "review.col.doc": "Document",
  "review.col.text": "Texte",
  "review.col.whyNot": "Pourquoi il n'a pas été utilisé",
  "review.where": "D'où vient chaque valeur",
  "review.namedDefault": "Une valeur par défaut nommée, acceptée explicitement.",
  "review.selectValue": "Sélectionnez une valeur pour voir la ligne d'où elle a été lue.",
  "review.recorded": "Chaque action est consignée",
  "review.recordedBody": "Votre choix, ses sources et votre nom vont dans la piste d'audit. Une valeur qui change après une analyse rend cette analyse périmée.",
  "review.sourceReason": "Source ou justification",
  "review.revenueProgram": "Programme de revenus (au moins un type de logement ou d'espace)",
  "review.enterNumber": "Saisissez un nombre.",
  "review.rejectedInReview": "Rejetée à l'examen",
  "review.declined": "Refusée par le second approbateur",

  "run.noRun": "Aucune analyse pour l'instant",
  "run.noRunBody": "Une analyse lit uniquement les données approuvées, construit un grand livre mensuel, le recalcule sous six stress et un stress combiné, et consigne un verdict reproductible à l'identique.",
  "run.run": "Lancer l'analyse",
  "run.running": "Calcul…",
  "run.again": "Relancer l'analyse",
  "run.blockedWhy": (p) => `Bloqué jusqu'à la fin de l'examen : ${p.why}.`,
  "run.viewerWhy": "Les lecteurs peuvent consulter les résultats mais pas lancer d'analyse.",
  "run.loading": "Chargement de l'analyse…",
  "run.outOfDate": (p) => `L'analyse ${p.n} est périmée.`,
  "run.outOfDateBody": "Ses chiffres sont affichés tels qu'ils étaient ; relancez l'analyse avant de décider.",
  "run.verdictLabel": (p) => `Verdict · Analyse ${p.n} · ${p.policy}`,
  "run.memo": "Générer le mémo du comité",
  "run.decide": "Consigner la décision",
  "run.explore": "Explorer des variantes",
  "run.gates": "Seuils",
  "run.col.gate": "Seuil",
  "run.col.needs": "Exigé",
  "run.col.result": "Résultat",
  "run.col.outcome": "Issue",
  "run.passes": "Respecté",
  "run.fails": "Non respecté",
  "run.notEvaluated": "Non évalué",
  "run.gatesNote": "Les résultats des seuils sont enregistrés avec l'analyse. Le mémo et chaque rapport lisent ces lignes ; rien ne les recalcule.",
  "run.stresses": "Stress",
  "run.col.scenario": "Scénario",
  "run.readByGates": " · lu par les seuils",
  "run.annual": "Flux de trésorerie annuels",
  "run.col.period": "Période",
  "run.col.egi": "RBE",
  "run.col.opex": "Charges d'exploitation",
  "run.col.noi": "RNE",
  "run.col.ds": "Service de la dette",
  "run.col.cf": "Flux de trésorerie",
  "run.beforeStab": "Avant la stabilisation",
  "run.year": (p) => `Année ${p.n}`,
  "run.howMade": (p) => `Comment est calculé : ${p.label}`,
  "run.keyFigures": "Chiffres clés",
  "run.selectFigure": "Sélectionnez un chiffre pour voir sa formule.",
  "run.checks": "Contrôles",
  "run.pass": "Conforme",
  "run.check": "À vérifier",
  "run.record": "Registre de l'analyse",
  "run.current": "À jour · données inchangées depuis cette analyse",
  "run.stale": "Périmée",
  "run.recordLine": (p) => `Analyse ${p.n} · moteur ${p.engine} · ${p.policy}`,
  "run.hashes": (p) => `données ${p.i} · résultat ${p.r}`,
  "run.signed": (p) => `signée avec la ${p.key}`,
  "run.devKey": "clé de développement",
  "run.prodKey": "clé de production",
  "run.package": "Télécharger le dossier d'audit",
  "run.inputs": "Données utilisées par cette analyse",
  "run.history": "Historique des analyses",
  "run.stale.inputs": "Une donnée approuvée a changé après cette analyse.",
  "run.stale.policy": "Les seuils de la politique ont changé après cette analyse.",
  "run.stale.engine": "Le moteur a été mis à jour après cette analyse.",

  "explore.title": "Explorer des variantes",
  "explore.banner": "Exploration, pas une analyse.",
  "explore.bannerBody": (p) => `Chaque chiffre ici est un nouveau calcul de l'analyse ${p.n} avec vos changements. Rien n'est enregistré, et rien ne peut être exporté ni servir à une décision.`,
  "explore.noRun": "L'exploration part d'une analyse existante.",
  "explore.drivers": "Modifier les hypothèses",
  "explore.reset": "Réinitialiser",
  "explore.results": "Ce qui change",
  "explore.col.metric": "Chiffre",
  "explore.col.run": "Analyse",
  "explore.col.explored": "Exploré",
  "explore.col.change": "Écart",
  "explore.verdictNow": "Verdict avec ces changements",
  "explore.tornado": "Les hypothèses qui comptent le plus",
  "explore.tornadoBody": "Chaque barre fait varier une hypothèse vers le bas puis vers le haut du montant indiqué, toutes les autres restant aux valeurs de l'analyse.",
  "explore.metric": "Chiffre",
  "explore.base": (p) => `Valeur de l'analyse ${p.v}`,
  "explore.lowers": "Fait baisser le chiffre",
  "explore.raises": "Fait monter le chiffre",
  "explore.grid": "Deux hypothèses à la fois",
  "explore.gridBody": (p) => `Les cellules marquées comme non conformes sont sous ${p.t}.`,
  "explore.gridBodyNone": "Chaque cellule est un nouveau calcul avec les deux changements appliqués.",
  "explore.across": "En colonnes",
  "explore.down": "En lignes",
  "explore.belowGate": "Sous le seuil",
  "explore.table": "Afficher sous forme de tableau",
  "explore.unchanged": "inchangé",
  "explore.working": "Calcul…",

  "decision.noRun": "Il n'y a pas encore d'analyse sur laquelle décider.",
  "decision.noRunBody": "Une décision du comité est toujours consignée pour une analyse précise.",
  "decision.goRun": "Aller à l'analyse",
  "decision.recorded": "Décisions consignées",
  "decision.conditions": (p) => `Conditions : ${p.c}`,
  "decision.against": (p) => `Décision contraire au verdict « ${p.v} », parce que : ${p.r}`,
  "decision.permanent": "registre permanent",
  "decision.cannot": "Aucune décision ne peut être consignée pour l'instant.",
  "decision.stale": "Les données ont changé après cette analyse. Relancez d'abord l'analyse.",
  "decision.role": "Seul un administrateur ou le propriétaire de l'espace consigne les décisions du comité.",
  "decision.further": "Consigner une autre décision",
  "decision.title": "Décision du comité",
  "decision.reasoning": "Motifs du comité",
  "decision.conditionsLabel": "Conditions",
  "decision.overrideLabel": (p) => `Pourquoi approuver malgré un verdict « ${p.v} »`,
  "decision.overrideHelp": "Obligatoire. Consigné avec la décision et affiché dans chaque rapport.",
  "decision.record": "Consigner la décision",
  "decision.permanentNote": "Les décisions sont permanentes. Une décision ultérieure s'ajoute ; elle ne remplace rien.",
  "decision.binds": "Ce à quoi la décision est liée",
  "decision.bindsBody": (p) => `Cette décision vise l'analyse ${p.n} : ses données exactes, la version du moteur et la politique. Si une donnée change ensuite, l'analyse devient périmée et une nouvelle décision exige une nouvelle analyse.`,

  "reports.needRun": "Les rapports sont produits à partir d'une analyse.",
  "reports.needRunBody": "Lancez d'abord l'analyse ; chaque chiffre d'un rapport en provient.",
  "reports.stale": (p) => `L'analyse ${p.n} est périmée.`,
  "reports.staleBody": "Les rapports qui en sont tirés affichent ses chiffres tels qu'ils étaient, avec le numéro d'analyse.",
  "reports.generate": (p) => `Générer à partir de l'analyse ${p.n}`,
  "reports.memo": "Mémo du comité",
  "reports.lender": "Dossier pour le prêteur",
  "reports.model": "Modèle",
  "reports.modelExport": "Export du modèle",
  "reports.word": "Word",
  "reports.excel": "Excel",
  "reports.package": "Dossier d'audit",
  "reports.note": "Chaque nombre d'un mémo est imprimé à partir de l'analyse avec sa source consignée. Avant la diffusion d'un fichier, un contrôle vérifie qu'aucun chiffre n'en est dépourvu ; sinon, le fichier est bloqué.",
  "reports.memoLang": "Les mémos et rapports sont rédigés en anglais.",
  "reports.col.report": "Rapport",
  "reports.col.status": "Statut",
  "reports.col.created": "Créé",
  "reports.ready": "Prêt",
  "reports.traced": (p) => ` · ${p.n} chiffres retracés`,
  "reports.rendering": "Production en cours",
  "reports.blocked": "Bloqué",
  "reports.failed": "Échec",
  "reports.none": "Aucun rapport pour l'instant.",

  "audit.title": "Piste d'audit",
  "audit.body": "Chaque événement est lié au précédent par une empreinte. Rien dans cette liste ne peut être modifié ni supprimé.",
  "audit.intact": (p) => `Chaîne intacte · ${p.n} événements`,
  "audit.broken": (p) => `Chaîne rompue à l'événement ${p.n}`,
  "audit.verify": "Vérifier la chaîne",
  "audit.col.event": "Événement",
  "audit.col.who": "Qui",
  "audit.col.when": "Quand",
  "audit.col.hash": "Empreinte",
  "audit.worker": "Processus Agir",

  "settings.title": "Paramètres",
  "settings.role": (p) => `${p.ws} · votre rôle : ${p.role}`,
  "settings.people": "Personnes de cet espace",
  "settings.col.name": "Nom",
  "settings.col.email": "Courriel",
  "settings.col.role": "Rôle",
  "settings.add": "Ajouter une personne qui a déjà un compte",
  "settings.addBtn": "Ajouter",
  "settings.roles": "Ce que chaque rôle permet",
  "settings.r.viewer": "Consulte chaque projet, analyse, rapport et la piste d'audit.",
  "settings.r.analyst": "Téléverse des documents, examine les valeurs, lance les analyses, produit les rapports.",
  "settings.r.admin": "Tout ce que fait un analyste, plus les décisions du comité et l'ajout de personnes.",
  "settings.r.owner": "Tout ce que fait un administrateur. A créé l'espace.",
  "settings.newWs": "Nouvel espace de travail",
  "settings.create": "Créer",
  "settings.language": "Langue",
  "settings.languageBody": "L'interface et ses nombres suivent ce choix. Il est mémorisé sur cet appareil.",
};

// ---- Catalog labels in French ------------------------------------------------------------
const FR_FIELDS: Record<string, string> = {
  land_cost: "Coût du terrain", hard_cost: "Coûts directs", soft_cost: "Coûts indirects", contingency: "Provision pour imprévus", other_cost: "Autres coûts",
  unit_count: "Logements", unit_rent_monthly: "Loyer par logement par mois", rentable_area_sf: "Superficie locative", rent_psf_annual: "Loyer par pi² par an",
  item_occupancy_pct: "Occupation de la composante", construction_months: "Durée de construction", lease_up_months: "Période de location",
  hold_years: "Période de détention", stabilized_occupancy_pct: "Occupation stabilisée", expense_ratio_pct: "Ratio des charges d'exploitation",
  fixed_opex_annual: "Charges d'exploitation fixes", variable_expense_pct: "Charges variables (part du RBE)", other_income_annual: "Autres revenus",
  rent_growth_pct: "Croissance des loyers", expense_growth_pct: "Croissance des charges", lease_up_ramp: "Revenus pendant la période de location",
  s_curve_draws: "Tirages de construction en courbe en S", exit_cap_rate_pct: "Taux de capitalisation à la sortie", selling_costs_pct: "Frais de vente",
  senior_loan_amount: "Montant du prêt principal", senior_rate_pct: "Taux du prêt principal", senior_amort_years: "Amortissement du prêt principal",
  senior_io_months: "Période d'intérêts seulement (prêt principal)", min_dscr_covenant: "Clause de RCSD minimal", mezz_loan_amount: "Montant du prêt mezzanine",
  mezz_rate_pct: "Taux du prêt mezzanine", mezz_amort_years: "Amortissement du prêt mezzanine", mezz_io_months: "Période d'intérêts seulement (mezzanine)",
  equity_amount: "Fonds propres déclarés", refinance_month: "Mois du refinancement", refinance_amount: "Montant du refinancement",
  refinance_ltv_pct: "Ratio prêt-valeur du refinancement", refinance_rate_pct: "Taux du refinancement", refinance_amort_years: "Amortissement du refinancement",
  refinance_io_months: "Période d'intérêts seulement (refinancement)", lp_share_pct: "Part des commanditaires", preferred_return_pct: "Rendement privilégié",
  gp_promote_pct: "Intéressement du commandité au-delà du rendement privilégié", stated_total_cost: "Coût total déclaré du projet",
  stated_ltc_pct: "Ratio prêt-coût déclaré", stated_interest_reserve: "Réserve d'intérêts déclarée",
};
const FR_HELP: Record<string, string> = {
  contingency: "Saisissez 0 si le budget n'en prévoit pas.",
  lease_up_months: "Saisissez 0 si l'actif est stabilisé dès la fin des travaux.",
  expense_ratio_pct: "Part du RBE de l'année 1, maintenue en dollars fixes et indexée selon la croissance des charges.",
  senior_loan_amount: "Saisissez 0 pour un projet financé entièrement par fonds propres.",
};
const GROUPS: Record<string, [string, string]> = {
  budget: ["Budget", "Budget"], revenue: ["Revenue", "Revenus"], timeline: ["Timeline", "Échéancier"], operations: ["Operations", "Exploitation"],
  exit: ["Exit", "Sortie"], senior: ["Senior loan", "Prêt principal"], mezzanine: ["Mezzanine loan", "Prêt mezzanine"], equity: ["Equity", "Fonds propres"],
  refinance: ["Refinance", "Refinancement"], waterfall: ["LP/GP split", "Partage commanditaires-commandité"], stated: ["Stated figures (checks)", "Chiffres déclarés (contrôles)"],
};
const FR_METRICS: Record<string, [string, string]> = {
  total_development_cost: ["Coût total de développement", "terrain + coûts directs + coûts indirects + imprévus + autres coûts + intérêts capitalisés"],
  capitalized_interest: ["Intérêts capitalisés", "intérêts courus sur la dette tirée avant la stabilisation"],
  hard_and_soft_cost: ["Coûts avant financement", "terrain + coûts directs + coûts indirects + imprévus + autres coûts"],
  gross_potential_rent: ["Loyer brut potentiel (année 1)", "somme des loyers des composantes sur la première année stabilisée"],
  effective_gross_income: ["Revenu brut effectif (année 1)", "loyers x occupation + autres revenus, première année stabilisée"],
  operating_expenses: ["Charges d'exploitation (année 1)", "part fixe + part variable du RBE, première année stabilisée"],
  stabilized_noi: ["RNE stabilisé", "RBE - charges d'exploitation, première année stabilisée"],
  yield_on_cost: ["Rendement sur coût", "RNE stabilisé / coût total de développement"],
  development_spread: ["Écart de développement", "(rendement sur coût - taux de sortie) x 100"],
  exit_value: ["Valeur de sortie", "RNE de la dernière année de détention / taux de sortie"],
  net_sale_proceeds: ["Produit net de la vente", "valeur de sortie x (1 - frais de vente)"],
  development_profit: ["Profit de développement", "produit net de la vente - coût total de développement"],
  profit_on_cost: ["Profit sur coût", "profit de développement / coût total de développement"],
  total_debt: ["Dette totale à la stabilisation", "soldes du prêt principal et mezzanine, intérêts capitalisés compris"],
  loan_to_cost: ["Ratio prêt-coût", "engagements de dette / coût total de développement"],
  required_equity: ["Fonds propres requis", "coût total de développement - engagements de dette"],
  debt_yield: ["Rendement de la dette", "RNE stabilisé / dette totale à la stabilisation"],
  sizing_dscr: ["RCSD de dimensionnement (pire année)", "minimum, sur les années de détention, du RNE / service de la dette amorti en vigueur"],
  sizing_dscr_year1: ["RCSD de dimensionnement (année 1)", "RNE de l'année 1 / service de la dette amorti en vigueur"],
  contractual_dscr: ["RCSD contractuel (pire année)", "minimum, sur les années de détention, du RNE / service de la dette réellement dû"],
  senior_dscr_year1: ["RCSD du prêt principal (année 1)", "RNE de l'année 1 / service amorti du prêt principal"],
  mezz_dscr_year1: ["RCSD global avec mezzanine (année 1)", "RNE de l'année 1 / service amorti du prêt principal et mezzanine"],
  break_even_occupancy: ["Occupation au seuil de rentabilité (année 1)", "(coûts fixes + service de la dette) / (loyers x (1 - part variable))"],
  cash_on_cash_year1: ["Rendement en espèces (année 1)", "flux de l'année 1 après service de la dette / fonds propres requis"],
  equity_multiple: ["Multiple des fonds propres", "total des distributions / total des apports"],
  equity_irr: ["TRI des fonds propres", "taux qui annule la VAN des flux datés des fonds propres"],
  peak_equity: ["Fonds propres maximaux engagés", "plus grand apport net cumulé"],
  refinance_net_proceeds: ["Produit net du refinancement", "nouveau prêt - remboursement du solde du prêt principal"],
  cost_per_unit: ["Coût par logement", "coût total de développement / logements"],
  lp_irr: ["TRI des commanditaires", "TRI de la part des commanditaires après la cascade"],
  gp_irr: ["TRI du commandité", "TRI de la part du commandité après la cascade"],
  gp_promote: ["Intéressement du commandité", "distributions du commandité au-delà de sa quote-part"],
  stabilization_month: ["Mois de stabilisation", "construction + période de location"],
  sale_month: ["Mois de la vente", "stabilisation + 12 x années de détention - 1"],
};
const STRESS: Record<string, [string, string]> = {
  base: ["Base case", "Scénario de base"],
  exit_cap: ["Exit cap +75 bps", "Taux de sortie +75 pb"],
  cost: ["Costs +10%", "Coûts +10 %"],
  rate: ["Interest rate +150 bps", "Taux d'intérêt +150 pb"],
  rent: ["Rent -10%", "Loyers -10 %"],
  occupancy: ["Occupancy -5 pts", "Occupation -5 pts"],
  expense: ["Operating costs +5 pts", "Charges d'exploitation +5 pts"],
  combined: ["Combined", "Combiné"],
};
const GATES: Record<string, [string, string]> = {
  equity_multiple: ["Equity multiple", "Multiple des fonds propres"],
  profit_on_cost: ["Profit on cost", "Profit sur coût"],
  development_spread: ["Development spread", "Écart de développement"],
  stressed_sizing_dscr: ["Sizing DSCR, combined stress", "RCSD de dimensionnement, stress combiné"],
  stressed_equity_multiple: ["Equity multiple, combined stress", "Multiple des fonds propres, stress combiné"],
};
const DRIVERS_L: Record<string, [string, string]> = {
  exitCapBps: ["Exit cap rate", "Taux de sortie"],
  rentPct: ["Rents", "Loyers"],
  occupancyPts: ["Occupancy", "Occupation"],
  costPct: ["Development costs", "Coûts de développement"],
  expensePts: ["Operating costs", "Charges d'exploitation"],
  rateBps: ["Interest rates", "Taux d'intérêt"],
  constructionMonths: ["Construction period", "Durée de construction"],
  leaseUpMonths: ["Lease-up period", "Période de location"],
};
const VERDICT: Record<string, [string, string]> = {
  APPROVE: ["Approve", "Approuver"],
  APPROVE_WITH_CONDITIONS: ["Approve with conditions", "Approuver sous conditions"],
  REJECT: ["Reject", "Rejeter"],
  NOT_EVALUATED: ["Not evaluated", "Non évalué"],
};
const DECISION: Record<string, [string, string]> = {
  approve: ["Approve", "Approuver"],
  approve_with_conditions: ["Approve with conditions", "Approuver sous conditions"],
  reject: ["Reject", "Rejeter"],
  return_to_underwriting: ["Return to underwriting", "Renvoyer à l'analyse"],
};
const ROLES: Record<string, [string, string]> = {
  owner: ["owner", "propriétaire"], admin: ["admin", "administrateur"], analyst: ["analyst", "analyste"], viewer: ["viewer", "lecteur"],
};
const ASSETS: Record<string, string> = {
  Multifamily: "Multilogement", "Mixed-use": "Usage mixte", Industrial: "Industriel", Office: "Bureaux", Retail: "Commerce de détail",
  Hospitality: "Hôtellerie", "Self storage": "Entreposage libre-service", Other: "Autre",
};

// ---- Messages produced by the engine and the API, in French ----------------------------------
const FR_REASONS: [RegExp, string | ((m: RegExpMatchArray) => string)][] = [
  [/^The inputs do not give this a meaningful value\.$/, "Les données ne permettent pas d'en tirer une valeur significative."],
  [/^Total development cost is zero\.$/, "Le coût total de développement est nul."],
  [/^Stabilized NOI is not positive, so the deal cannot be capitalized\.$/, "Le RNE stabilisé n'est pas positif ; le projet ne peut pas être capitalisé."],
  [/^Final-year NOI is not positive, so the asset has no capitalized value\.$/, "Le RNE de la dernière année n'est pas positif ; l'actif n'a pas de valeur capitalisée."],
  [/^The deal has no debt\.$/, "Le projet n'a pas de dette."],
  [/^No debt at stabilization\.$/, "Aucune dette à la stabilisation."],
  [/^No senior loan is in force in year 1\.$/, "Aucun prêt principal n'est en vigueur à l'année 1."],
  [/^No mezzanine loan\.$/, "Aucun prêt mezzanine."],
  [/^No rent to cover costs with\.$/, "Aucun loyer pour couvrir les coûts."],
  [/^No equity is contributed, so there is nothing to multiply\.$/, "Aucun fonds propre n'est apporté ; il n'y a rien à multiplier."],
  [/^No equity is contributed\.$/, "Aucun fonds propre n'est apporté."],
  [/^The equity cash flows have no rate of return \(no sign change\)\.$/, "Les flux des fonds propres n'ont pas de taux de rendement (aucun changement de signe)."],
  [/^The equity cash flows have (\d+) IRRs \((.+)\), so no single IRR is meaningful\.$/, (m) => `Les flux des fonds propres ont ${m[1]} TRI (${m[2]}) ; aucun TRI unique n'est significatif.`],
  [/^No refinance\.$/, "Aucun refinancement."],
  [/^The program has no dwelling units\.$/, "Le programme ne compte aucun logement."],
  [/^No LP\/GP split\.$/, "Aucun partage commanditaires-commandité."],
  [/^Deal returns are not meaningful\.$/, "Les rendements du projet ne sont pas significatifs."],
  [/^The LP cash flows have no single IRR\.$/, "Les flux des commanditaires n'ont pas de TRI unique."],
  [/^The GP cash flows have no single IRR\.$/, "Les flux du commandité n'ont pas de TRI unique."],
  // Extraction notes and document states.
  [/^"(.+)" is an output figure, which is never taken as an input$/, (m) => `« ${m[1]} » est un résultat ; il n'est jamais retenu comme donnée`],
  [/^"(.+)" could be (.+) or (.+); the document does not group thousands with spaces elsewhere$/, (m) => `« ${m[1]} » peut se lire ${m[2]} ou ${m[3]} ; le document ne groupe pas les milliers par des espaces ailleurs`],
  [/^"(.+)" could be (.+) or (.+); the document does not say which$/, (m) => `« ${m[1]} » peut se lire ${m[2]} ou ${m[3]} ; le document ne précise pas lequel`],
  [/^"(.+)" uses a different decimal separator from the rest of the document$/, (m) => `« ${m[1]} » utilise un autre séparateur décimal que le reste du document`],
  [/^"(.+)" would be a figure with three decimal places, which money, counts and areas never have$/, (m) => `« ${m[1]} » aurait trois décimales, ce qu'un montant, un nombre ou une superficie n'a jamais`],
  [/^"(.+)" is not a well-formed number$/, (m) => `« ${m[1]} » n'est pas un nombre bien formé`],
  [/^page (\d+), line (\d+)$/, (m) => `page ${m[1]}, ligne ${m[2]}`],
  [/^line (\d+)$/, (m) => `ligne ${m[1]}`],
  [/^paragraph (\d+)$/, (m) => `paragraphe ${m[1]}`],
  [/^Approved earlier$/, "Approuvée précédemment"],
  [/^Entered by an analyst$/, "Saisie par un analyste"],
  [/^Default accepted$/, "Valeur par défaut acceptée"],
  [/^Its source document was removed; confirm or reject it$/, "Son document source a été retiré ; confirmez-la ou rejetez-la"],
  [/^Its source document was removed$/, "Son document source a été retiré"],
  [/^Rejected in review$/, "Rejetée à l'examen"],
  [/^Second approver declined$/, "Refusée par le second approbateur"],
  [/^Entered by (.+?)(: .*)?$/, (m) => `Saisie par ${m[1]}${m[2] ?? ""}`],
  [/^No field matches this label$/, "Aucun champ ne correspond à ce libellé"],
  [/^No budget line matches this label$/, "Aucune ligne de budget ne correspond à ce libellé"],
  [/^Another number on this line was used$/, "Un autre nombre de cette ligne a été retenu"],
  [/^Looks like .+, but the number is not written as .+\. Enter it by hand if it is\.$/, "Ressemble à un champ connu, mais le nombre n'est pas écrit dans l'unité attendue. Saisissez-le à la main s'il y a lieu."],
  [/^The file does not start like a PDF$/, "Le fichier ne commence pas comme un PDF"],
  [/^The file is not an Office (\w+) package$/, (m) => `Le fichier n'est pas un paquet Office ${m[1]}`],
  [/^A text file cannot contain binary data$/, "Un fichier texte ne peut pas contenir de données binaires"],
  [/^The text is not valid UTF-8$/, "Le texte n'est pas en UTF-8 valide"],
  [/^The stored file does not match the size that was uploaded$/, "Le fichier stocké ne correspond pas à la taille téléversée"],
  [/^The stored file does not match the fingerprint recorded at upload$/, "Le fichier stocké ne correspond pas à l'empreinte consignée au téléversement"],
  [/^The file is larger than 75 MB\.?$/, "Le fichier dépasse 75 Mo."],
  [/^This PDF is scanned pages with no text layer\./, "Ce PDF est composé de pages numérisées sans couche de texte. Agir ne fait pas encore de reconnaissance optique : saisissez ses valeurs à la main ou téléversez un PDF textuel."],
  [/^Agir could not process this file after several attempts\./, "Agir n'a pas pu traiter ce fichier après plusieurs tentatives. Relancez-le ou téléversez-le de nouveau."],
  [/^Agir could not read this file: (.+)$/, (m) => `Agir n'a pas pu lire ce fichier : ${m[1]}`],
  // API errors.
  [/^Your role in this workspace does not allow this action$/, "Votre rôle dans cet espace ne permet pas cette action"],
  [/^Sign in to continue\.$/, "Connectez-vous pour continuer."],
  [/^That email and password do not match\.$/, "Ce courriel et ce mot de passe ne correspondent pas."],
  [/^An account with that email already exists\.$/, "Un compte existe déjà avec ce courriel."],
  [/^Too many attempts\. Wait a minute\.$/, "Trop de tentatives. Patientez une minute."],
  [/^Some fields are missing or not valid\.$/, "Des champs manquent ou ne sont pas valides."],
  [/^Underwriting is blocked until review is clear\.$/, "L'analyse est bloquée jusqu'à la fin de l'examen."],
  [/^Someone changed this value while you were looking at it\. Reload and try again\.$/, "Quelqu'un a modifié cette valeur pendant que vous la consultiez. Rechargez la page et réessayez."],
  [/^A conflict can only be resolved to one of the documented values\./, "Un conflit ne peut être résolu que par l'une des valeurs documentées. Utilisez « Saisir une autre valeur » pour déroger."],
  [/^Say why you are entering a different value \(at least 10 characters\)$/, "Expliquez pourquoi vous saisissez une autre valeur (au moins 10 caractères)"],
  [/^A second approver must be a different person from the one who entered the value$/, "Le second approbateur doit être une autre personne que celle qui a saisi la valeur"],
  [/^Say where this value comes from \(at least 10 characters\)$/, "Précisez d'où vient cette valeur (au moins 10 caractères)"],
  [/^This field already has a value; review it instead$/, "Ce champ a déjà une valeur ; examinez-la plutôt"],
  [/^State the conditions$/, "Précisez les conditions"],
  [/^The inputs changed after this run\. Run underwriting again before recording a decision\.$/, "Les données ont changé après cette analyse. Relancez l'analyse avant de consigner une décision."],
  [/^A newer run exists\. Decide on the latest run\.$/, "Une analyse plus récente existe. Décidez sur la plus récente."],
  [/^Approving against a (\w+) verdict needs a written reason/, "Approuver malgré le verdict exige une justification écrite (au moins 20 caractères)"],
  [/^Upload a PDF, Excel \(\.xlsx\), CSV, Word \(\.docx\) or text file\.$/, "Téléversez un fichier PDF, Excel (.xlsx), CSV, Word (.docx) ou texte."],
  [/^The file is empty\.$/, "Le fichier est vide."],
  [/^Only a document that could not be read can be retried$/, "Seul un document qui n'a pas pu être lu peut être relancé"],
  [/^Something went wrong on our side\. It has been logged\.$/, "Un problème est survenu de notre côté. Il a été consigné."],
  [/^Choose two different drivers\.$/, "Choisissez deux hypothèses différentes."],
  [/^The approved inputs changed while the run was being computed\. Run it again\.$/, "Les données approuvées ont changé pendant le calcul. Relancez l'analyse."],
  [/^Give the committee's reasoning/, "Indiquez les motifs du comité (au moins 10 caractères)"],
  [/^(.+) (cannot be below|cannot be above|must be a whole number|needs a number)(.*)$/, (m) => `${m[1]} : ${m[2] === "cannot be below" ? "ne peut pas être inférieur à" : m[2] === "cannot be above" ? "ne peut pas être supérieur à" : m[2] === "must be a whole number" ? "doit être un nombre entier" : "exige un nombre"}${m[3]}`],
];

export function translateMessage(text: string | null | undefined): string {
  if (!text) return "";
  for (const [re, out] of FR_REASONS) {
    const m = text.match(re);
    if (m) return typeof out === "string" ? out : out(m);
  }
  return text;
}

// ---- Numbers --------------------------------------------------------------------------------
function makeFormat(lang: Lang) {
  const loc = lang === "fr" ? "fr-CA" : "en-US";
  const n0 = new Intl.NumberFormat(loc, { maximumFractionDigits: 0 });
  const n2 = new Intl.NumberFormat(loc, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nMax2 = new Intl.NumberFormat(loc, { maximumFractionDigits: 2 });
  const fr = lang === "fr";
  const nm = fr ? "Non significatif" : "Not meaningful";
  const money = (v: number) => (fr ? `${v < 0 ? "-" : ""}${n0.format(Math.abs(Math.round(v)))} $` : `${v < 0 ? "-" : ""}$${n0.format(Math.abs(Math.round(v)))}`);
  // French puts a space before units and currency; it must not break, so "51 962 556 $" stays on one line.
  const keep = (text: string) => (fr ? text.replace(/ /g, "\u00a0") : text);
  const value = (v: number | null | undefined, unit: string): string => (v === null || v === undefined || !Number.isFinite(v) ? nm : keep(plain(v, unit)));
  const plain = (v: number, unit: string): string => {
    switch (unit) {
      case "$": return money(v);
      case "%": return fr ? `${n2.format(v)} %` : `${n2.format(v)}%`;
      case "x": return `${n2.format(v)}x`;
      case "bps": return fr ? `${n0.format(Math.round(v))} pb` : `${n0.format(Math.round(v))} bps`;
      case "months": return fr ? `${n0.format(v)} mois` : `${n0.format(v)} mo`;
      case "years": return fr ? `${nMax2.format(v)} ${v === 1 ? "an" : "ans"}` : `${nMax2.format(v)} yr`;
      case "units": case "count": return n0.format(v);
      case "sf": return fr ? `${n0.format(Math.round(v))} pi²` : `${n0.format(Math.round(v))} SF`;
      case "$/unit/mo": case "$/mo": return fr ? `${nMax2.format(v)} $/mois` : `$${nMax2.format(v)}/mo`;
      case "$/sf/yr": case "$/sf": return fr ? `${n2.format(v)} $/pi²/an` : `$${n2.format(v)}/SF/yr`;
      case "flag": return v === 1 ? (fr ? "Oui" : "Yes") : fr ? "Non" : "No";
      case "pts": return fr ? `${nMax2.format(v)} pts` : `${nMax2.format(v)} pts`;
      default: return nMax2.format(v);
    }
  };
  /** A signed change, e.g. +75 bps or -10%. */
  const delta = (v: number, unit: string): string => keep(signed(v, unit));
  const signed = (v: number, unit: string): string => {
    const sign = v > 0 ? "+" : v < 0 ? "-" : "±";
    const a = Math.abs(v);
    if (unit === "%") return `${sign}${fr ? `${nMax2.format(a)} %` : `${nMax2.format(a)}%`}`;
    if (unit === "bps") return `${sign}${n0.format(a)} ${fr ? "pb" : "bps"}`;
    if (unit === "pts") return `${sign}${nMax2.format(a)} pts`;
    if (unit === "months") return `${sign}${n0.format(a)} ${fr ? "mois" : "mo"}`;
    return `${sign}${plain(a, unit)}`;
  };
  const suffix = (unit: string): string =>
    (fr
      ? { "%": "%", months: "mois", years: "ans", units: "logements", sf: "pi²", "$/unit/mo": "$/mois", "$/sf/yr": "$/pi²/an", x: "x", $: "$" }
      : { "%": "%", months: "months", years: "years", units: "units", sf: "SF", "$/unit/mo": "$/mo", "$/sf/yr": "$/SF/yr", x: "x", $: "$" })[unit] ?? "";
  const date = (iso: string) => new Date(iso).toLocaleString(fr ? "fr-CA" : "en-CA", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const bytes = (b: number) => (b < 1024 ? `${b} ${fr ? "o" : "B"}` : b < 1048576 ? `${n0.format(b / 1024)} ${fr ? "Ko" : "KB"}` : `${new Intl.NumberFormat(loc, { maximumFractionDigits: 1 }).format(b / 1048576)} ${fr ? "Mo" : "MB"}`);
  /** Read a number typed in this language: "5,25" in French, "1,250,000" in English. */
  const parse = (raw: FormDataEntryValue | string | null): number => {
    let t = String(raw ?? "").replace(/[\s  $%]/g, "");
    t = fr ? t.replace(/,/g, ".") : t.replace(/,/g, "");
    const n = Number(t);
    if (!t || !Number.isFinite(n)) throw new Error(fr ? "Saisissez un nombre." : "Enter a number.");
    return n;
  };
  return { value, delta, suffix, date, bytes, parse, money: (v: number) => keep(money(v)) };
}

// ---- Context --------------------------------------------------------------------------------
function initialLang(): Lang {
  try {
    const saved = localStorage.getItem("agir.lang");
    if (saved === "en" || saved === "fr") return saved;
  } catch {
    /* storage unavailable: fall back to the browser */
  }
  return typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("fr") ? "fr" : "en";
}

function build(lang: Lang, setLang: (l: Lang) => void) {
  const dict = lang === "fr" ? FR : EN;
  const idx = lang === "fr" ? 1 : 0;
  const t = <K extends Key>(key: K, p: Record<string, any> = {}): any => {
    const e = dict[key] as Entry;
    return typeof e === "function" ? e(p) : e;
  };
  const f = makeFormat(lang);
  const L = {
    field: (key: string, item?: string | null) => {
      const base = lang === "fr" ? FR_FIELDS[key] ?? FIELD_BY_KEY.get(key)?.label ?? key : FIELD_BY_KEY.get(key)?.label ?? key;
      return item ? `${base} (${item})` : base;
    },
    help: (key: string, en: string | null) => (lang === "fr" ? FR_HELP[key] ?? en : en),
    group: (g: string) => GROUPS[g]?.[idx] ?? g,
    metric: (key: string) => (lang === "fr" ? FR_METRICS[key]?.[0] : METRIC_BY_KEY.get(key)?.label) ?? key,
    formula: (key: string) => (lang === "fr" ? FR_METRICS[key]?.[1] : METRIC_BY_KEY.get(key)?.formula) ?? "",
    stress: (key: string, en: string) => STRESS[key]?.[idx] ?? en,
    gate: (key: string, en: string) => GATES[key]?.[idx] ?? en,
    driver: (key: string) => DRIVERS_L[key]?.[idx] ?? key,
    verdict: (code: string) => VERDICT[code]?.[idx] ?? code,
    decision: (d: string) => DECISION[d]?.[idx] ?? d,
    role: (r: string) => ROLES[r]?.[idx] ?? r,
    asset: (a: string) => (lang === "fr" ? ASSETS[a] ?? a : a),
    place: (location: string, province: string | null) => placeLabel(location, province, lang),
    currency: (c: string | null) => {
      const names = CURRENCY_NAMES[c as Currency];
      if (!names) return t("deals.currencyNone") as string;
      return `${names[idx][0]!.toUpperCase()}${names[idx].slice(1)} (${c})`;
    },
  };
  const msg = (text: string | null | undefined) => (lang === "fr" ? translateMessage(text) : text ?? "");
  const err = (e: unknown) => msg(e instanceof Error ? e.message : String(e ?? ""));
  return { lang, setLang, t, f, L, msg, err };
}

export type I18n = ReturnType<typeof build>;
const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const setLang = (l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem("agir.lang", l);
    } catch {
      /* private window: the choice lasts for this tab */
    }
    document.documentElement.lang = l === "fr" ? "fr-CA" : "en";
  };
  const value = useMemo(() => build(lang, setLang), [lang]);
  if (typeof document !== "undefined") document.documentElement.lang = lang === "fr" ? "fr-CA" : "en";
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error("I18nProvider missing");
  return v;
}

// ---- Structured text shared by several screens ----------------------------------------------

export type VerdictLike = {
  code: string;
  hardFailReasons: string[];
  gates: { key: string; label: string; status: string }[];
};
export type CheckLike = { key: string; kind: string; severity: string; message: string; expected?: number; actual?: number };

/** The verdict's headline and explanation, in the chosen language, from the stored gates. */
export function verdictText(i: I18n, v: VerdictLike, checks: CheckLike[]): { headline: string; explanation: string } {
  if (i.lang === "en") {
    const failed = v.gates.filter((g) => g.status === "failed");
    const measured = v.gates.filter((g) => g.status !== "not_applicable").length;
    const ne = v.gates.filter((g) => g.status === "not_evaluated");
    const errors = checks.filter((c) => c.severity === "error");
    switch (v.code) {
      case "APPROVE":
        return { headline: measured === v.gates.length ? "All five gates pass." : `All ${measured} applicable gates pass.`, explanation: "The deal clears every return hurdle and holds its coverage under combined stress." };
      case "APPROVE_WITH_CONDITIONS":
        return { headline: `${failed.length} ${s(failed.length, "gate fails", "gates fail")}. The committee sets conditions.`, explanation: `Failing: ${failed.map((g) => g.label).join("; ")}.` };
      case "NOT_EVALUATED":
        return { headline: "Not evaluated. Nothing was decided.", explanation: `These gates could not be measured: ${ne.map((g) => g.label).join("; ")}.` };
      default:
        if (v.hardFailReasons.length) {
          return {
            headline: errors.length === 1 ? "The deal fails a check that no gate can offset." : `The deal fails ${errors.length} checks that no gate can offset.`,
            explanation: v.hardFailReasons.join(" "),
          };
        }
        return { headline: failed.length === measured ? `All ${measured === 5 ? "five" : measured} gates fail.` : `${failed.length} of ${measured} gates fail.`, explanation: `Failing: ${failed.map((g) => g.label).join("; ")}.` };
    }
  }
  const failed = v.gates.filter((g) => g.status === "failed").map((g) => i.L.gate(g.key, g.label));
  const measured = v.gates.filter((g) => g.status !== "not_applicable").length;
  const ne = v.gates.filter((g) => g.status === "not_evaluated").map((g) => i.L.gate(g.key, g.label));
  const errors = checks.filter((c) => c.severity === "error");
  switch (v.code) {
    case "APPROVE":
      return {
        headline: measured === v.gates.length ? "Les cinq seuils sont respectés." : `Les ${measured} seuils applicables sont respectés.`,
        explanation: "Le projet franchit tous les seuils de rendement et maintient sa couverture sous le stress combiné.",
      };
    case "APPROVE_WITH_CONDITIONS":
      return {
        headline: `${failed.length} ${s(failed.length, "seuil n'est pas respecté", "seuils ne sont pas respectés")}. Le comité fixe des conditions.`,
        explanation: `Non respectés : ${failed.join(" ; ")}.`,
      };
    case "NOT_EVALUATED":
      return { headline: "Non évalué. Aucune décision n'a été prise.", explanation: `Ces seuils n'ont pas pu être mesurés : ${ne.join(" ; ")}.` };
    default:
      if (v.hardFailReasons.length) {
        return {
          headline: errors.length === 1 ? "Le projet échoue à un contrôle qu'aucun seuil ne peut compenser." : `Le projet échoue à ${errors.length} contrôles qu'aucun seuil ne peut compenser.`,
          explanation: errors.map((c) => checkText(i, c)).join(" "),
        };
      }
      return {
        headline: failed.length === measured ? (measured === 5 ? "Aucun des cinq seuils n'est respecté." : `Aucun des ${measured} seuils n'est respecté.`) : `${failed.length} seuils sur ${measured} ne sont pas respectés.`,
        explanation: `Non respectés : ${failed.join(" ; ")}.`,
      };
  }
}

/** A check's message in the chosen language, from its key and figures. */
export function checkText(i: I18n, c: CheckLike, ltcCeiling = 85): string {
  if (i.lang === "en") return c.message;
  const $ = (v?: number) => i.f.value(v ?? NaN, "$");
  const pct = (v?: number) => i.f.value(v ?? NaN, "%");
  const x = (v?: number) => i.f.value(v ?? NaN, "x");
  const e = c.expected;
  const a = c.actual;
  switch (c.key) {
    case "debt_exceeds_cost":
      return `Les engagements de dette de ${$(a)} couvrent la totalité du coût de ${$(e)}. Les fonds propres seraient nuls ou négatifs : cette structure de capital ne peut pas exister.`;
    case "ltc_ceiling":
      return c.severity === "error"
        ? `Le ratio prêt-coût de ${pct(a)} dépasse le plafond de la politique, fixé à ${pct(e)}.`
        : `Le ratio prêt-coût de ${pct(a)} respecte le plafond de la politique, fixé à ${pct(ltcCeiling)}.`;
    case "noi_not_positive":
      return `Le RNE stabilisé est de ${$(a)}. Un projet déficitaire à la stabilisation ne peut pas être évalué par capitalisation.`;
    case "equity_wipeout":
      return `Le produit net de la vente, ${$(a)}, ne rembourse pas les ${$(e)} de dette en cours. Les fonds propres sont anéantis à la sortie.`;
    case "funding_not_converged":
      return "Les fonds propres requis n'ont pas pu être déterminés ; le plan de financement est incohérent.";
    case "sources_cover_uses":
      if (c.severity === "error") return `Les fonds propres déclarés de ${$(a)} ne couvrent pas les ${$(e)} requis (écart de ${$((e ?? 0) - (a ?? 0))}).`;
      if (c.severity === "warning") return `Les fonds propres déclarés de ${$(a)} dépassent de ${$((a ?? 0) - (e ?? 0))} le besoin ; le modèle n'apporte que ${$(e)}.`;
      return a === undefined ? "Aucun montant de fonds propres n'est indiqué ; les fonds propres correspondent à la part que la dette ne finance pas." : "Les sources égalent les emplois.";
    case "stated_total_cost":
      return c.severity === "pass" ? `Le coût total déclaré de ${$(a)} concorde avec le modèle.` : `Les documents indiquent un coût total de ${$(a)} ; le modèle calcule ${$(e)}.`;
    case "stated_ltc":
      return c.severity === "pass" ? `Le ratio prêt-coût déclaré de ${pct(a)} concorde avec le modèle.` : `Les documents indiquent un ratio prêt-coût de ${pct(a)} ; le modèle calcule ${pct(e)}.`;
    case "interest_reserve":
      return c.severity === "pass"
        ? `La réserve d'intérêts déclarée de ${$(a)} couvre les ${$(e)} calculés par le modèle.`
        : `Le budget prévoit une réserve d'intérêts de ${$(a)} ; le modèle calcule ${$(e)} d'intérêts avant la stabilisation. La réserve semble insuffisante de ${$((e ?? 0) - (a ?? 0))}.`;
    case "dscr_covenant":
      return c.severity === "pass"
        ? `Le RCSD contractuel de ${x(a)} respecte la clause de ${x(e)} chaque année de détention.`
        : `Le RCSD contractuel descend à ${x(a)}, sous la clause de ${x(e)}.`;
    case "base_sizing_dscr":
      return `Le RCSD de dimensionnement du scénario de base, ${x(a)}, est sous le plancher de ${x(e)}.`;
    default:
      return c.message;
  }
}

export type OverviewLike = {
  step: string;
  documents: { total: number; processing: number; failed: number };
  review: { needsReview: number; conflicting: number; awaitingSecond: number; missing: number; impossible: number; status: string };
  run: { verdict: string; fresh: boolean } | null;
  decision: { decision: string } | null;
  reports: number;
};

/** A deal's status line and next action, from its evidence, in the chosen language. */
export function dealStatus(i: I18n, o: OverviewLike): { tone: "pass" | "review" | "stop" | "neutral"; text: string; next: string; blockedParts: string[] } {
  const { t, L } = i;
  const r = o.review;
  if (o.documents.total === 0) return { tone: "neutral", text: t("status.noDocs"), next: t("next.upload"), blockedParts: [] };
  if (o.documents.processing > 0) {
    return {
      tone: "neutral",
      text: t("status.reading", { n: o.documents.processing }),
      next: o.documents.failed ? t("next.retry", { n: o.documents.failed }) : t("next.wait"),
      blockedParts: [],
    };
  }
  if (r.status === "blocked") {
    const parts = [
      r.conflicting && t("status.conflicts", { n: r.conflicting }),
      r.missing && t("status.missing", { n: r.missing }),
      r.needsReview && t("status.toReview", { n: r.needsReview }),
      r.awaitingSecond && t("status.awaiting", { n: r.awaitingSecond }),
      r.impossible && t("status.outOfRange", { n: r.impossible }),
    ].filter(Boolean) as string[];
    return {
      tone: r.conflicting || r.missing || r.impossible ? "stop" : "review",
      text: `${t("status.blocked")} · ${parts.join(", ")}`,
      next: r.conflicting ? t("next.resolve", { n: r.conflicting }) : r.missing ? t("next.enter", { n: r.missing }) : t("next.review"),
      blockedParts: parts,
    };
  }
  if (!o.run || !o.run.fresh) {
    return { tone: o.run ? "review" : "neutral", text: o.run ? t("status.outOfDate") : t("status.readyToRun"), next: t("next.run"), blockedParts: [] };
  }
  if (!o.decision) {
    const v = o.run.verdict;
    return { tone: v === "APPROVE" ? "pass" : v === "REJECT" ? "stop" : "review", text: t("status.verdict", { v: L.verdict(v) }), next: t("next.decide"), blockedParts: [] };
  }
  return {
    tone: o.decision.decision.startsWith("approve") ? "pass" : "stop",
    text: t("status.decided", { d: L.decision(o.decision.decision).toLowerCase() }),
    next: o.reports > 0 ? t("next.share") : t("next.memo"),
    blockedParts: [],
  };
}
