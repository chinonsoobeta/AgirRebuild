// English and French (Canada). Interface strings live here; so do the French
// labels for every field, metric, stress and gate in @agir/contracts, and the
// French forms of the messages the engine and the API produce. Numbers follow
// the language: 51,962,556 and 6.45% in English, 51 962 556 $ and 6,45 % in French.

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { CURRENCY_NAMES, FIELDS, FIELD_BY_KEY, METRIC_BY_KEY, placeLabel, type Currency, type ReadinessItem } from "@agir/contracts";

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
  "deals.summarySolo": (p) => `${p.blocked} ${s(p.blocked, "deal is", "deals are")} blocked. ${p.ready} ${s(p.ready, "is", "are")} ready for your decision.`,
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
  "copy.button": "Copy as a variant",
  "copy.title": "Copy as a variant",
  "copy.intro": "A variant is a copy of this deal in exactly its state: the same documents, values and approvals. Change it and run it to compare a scheme. Runs, decisions and reports stay with this deal.",
  "copy.name": "Name of the variant",
  "copy.suffix": ", variant",
  "copy.create": "Copy and open",
  "copy.variantOf": "Variant of",
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
  "status.outOfRange": (p) => `${p.n} to correct`,
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
  "next.decideSolo": "Record your decision",
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
  "review.updating": "Updating the review from your documents…",
  "review.stillReadingBody": "Values will appear here as each one finishes.",
  "review.suggested": "Suggested label, please confirm",
  "review.useAs": "Use as…",
  "review.useAsField": "Field",
  "review.useAsPick": "Choose a field",
  "review.useAsItem": "Item name",
  "review.labelledAs": (p) => `Labelled as ${p.field} by ${p.who}`,
  "review.undo": "Undo",
  "review.unusedLine": (p) => `${p.n} ${s(p.n, "figure", "figures")} in your documents ${s(p.n, "was", "were")} not used. You can label one as an input.`,
  "review.unusedLink": "Show the figures",
  "review.fromM2": "The document gives this in square metres. Agir works in square feet and converted it.",
  "review.statedIn": (p) => `The document states this in ${p.code}. It is shown here but never used.`,
  "review.summary": (p) => [`${p.c} conflicting`, `${p.m} missing`, `${p.r} to review`, `${p.a} approved`],
  "review.blocked": "Underwriting is blocked.",
  "review.b.conflicts": (p) => `${p.n} ${s(p.n, "input has", "inputs have")} documents that disagree`,
  "review.b.missing": (p) => `${p.n} required ${s(p.n, "input is", "inputs are")} missing`,
  "review.b.pending": (p) => `${p.n} extracted ${s(p.n, "value needs", "values need")} review`,
  "review.b.awaiting": (p) => `${p.n} ${s(p.n, "override is", "overrides are")} waiting for a second approver`,
  "review.b.impossible": (p) => `${p.n} ${s(p.n, "input needs", "inputs need")} correcting`,
  "review.impossible": "These inputs cannot be run together",
  "review.b.tail": ". Agir will not choose or fill in a value for you.",
  "review.clear": "Review is clear.",
  "review.clearBody": "Every required input is approved or a named default. Go to Run.",
  "review.statedWaiting": (p) => (p.n === 1 ? "One value was stated by one person and is not independently confirmed; it is listed under Approved." : `${p.n} values were stated by one person and are not independently confirmed; they are listed under Approved.`),
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
  "qs.title": "Quick start",
  "qs.intro": "No documents? Answer a few plain questions and get a deal you can run. Each answer is recorded with where it came from.",
  "qs.template": "What are you building?",
  "qs.t.multiplex": "Multiplex rental (2–4 units)",
  "qs.t.apartment": "Small apartment (5–30 units)",
  "qs.t.townhomes": "Townhomes for sale (2–30 units)",
  "qs.saleLine": "These units are sold, not rented.",
  "qs.unitSalePrice": "Sale price per unit",
  "qs.doneSales": "Your answers are saved.",
  "qs.saleGstQuestion": "What will GST/HST cost, net of rebates?",
  "qs.optional": "optional",
  "qs.sell": "Sell it",
  "qs.keep": "Keep it and refinance",
  "qs.amortUnused": "not needed: the loan is interest-only until the refinance",
  "qs.errRefinance": "Give the refinance loan amount or its loan-to-value, not both.",
  "qs.unitType": "Unit type, e.g. 2-bedroom",
  "qs.unitCount": "How many of this type?",
  "qs.unitRent": "Monthly rent per unit",
  "qs.addType": "Add a unit type",
  "qs.removeType": "Remove this unit type",
  "qs.reason": "Where do these figures come from? (recorded in the audit trail)",
  "qs.reasonDefault": "Stated in the quick start",
  "qs.defaultsTitle": "Standard assumptions",
  "qs.defaultsBody": "These standard assumptions will be used. Accept them, or change them later on the Review page.",
  "qs.accept": "Accept these defaults",
  "qs.defaultLine": (p) => `${p.label}: ${p.value}`,
  "qs.hidden": "Not asked",
  "qs.hiddenLine": (p) => `Not asked: ${p.label}, which means ${p.means}`,
  "qs.submit": "Save my answers",
  "qs.working": "Saving…",
  "qs.errUnits": (p) => `This kind of project has ${p.min} to ${p.max} units in total.`,
  "qs.errName": "Name each unit type.",
  "qs.errPipe": "A unit type name cannot contain \"|\".",
  "qs.errDup": "Each unit type needs a different name.",
  "qs.errRange": (p) => `${p.label} must be between ${p.min} and ${p.max}.`,
  "qs.errWhole": (p) => `${p.label} must be a whole number.`,
  "qs.errAccept": "Tick the box to accept the standard assumptions.",
  "qs.errReason": "Say where the figures come from (at least 10 characters).",
  "qs.done": "Your answers are saved and the standard assumptions are accepted.",
  "qs.next": "Go to Review, then run",
  "review.materialNote": "Material field: a second, different person must confirm this value before it counts.",
  "review.saveValue": "Save value",
  "review.missing": "Missing inputs",
  "review.nMissing": (p) => `${p.n} missing`,
  "review.acceptDefaults": (p) => `Accept ${p.n} ${s(p.n, "default", "defaults")}`,
  "review.missingBody": (p) => `No document states these. Enter each value and say where it comes from${p.defaults ? ", or accept the named defaults, which every report will disclose" : ""}.`,
  "review.notFound": "Not found in the documents",
  "review.notFoundBody": "No document states these, or Agir could not read them. They are not entered as values. If you have one, enter it and say where it comes from.",
  "review.notFoundLine": (p) => `${p.field} \u2014 not found. The run treats this as: ${p.meaning}.`,
  "review.notFoundEnter": "Enter a value",
  "review.choices": "Choices only you make",
  "review.choicesBody": "Agir never reads these from documents. If you leave one, the run uses what it says.",
  "review.choiceLine": (p) => `${p.field}: not stated. The run treats this as: ${p.meaning}.`,
  "review.choiceEnter": "Make this choice",
  "review.default": (p) => ` · default ${p.v}`,
  "review.materialTag": " · material",
  "review.sourceFor": (p) => `Source for ${p.label}`,
  "review.sourceHint": "Source or reason, e.g. sponsor call on Sept 12",
  "review.addItem": "Add a unit type or space",
  "review.addItemName": "Name, e.g. 3BR or Retail",
  "review.addItemPerUnit": "Rent per unit",
  "review.addItemPerSf": "Rent per square foot",
  "review.awaiting": "Waiting for a second approver",
  "review.enteredBy": (p) => `entered by ${p.who}${p.old ? `, replacing ${p.old}` : ""}`,
  "review.reason": (p) => `Reason: ${p.r}`,
  "review.confirm": "Confirm as second approver",
  "review.decline": "Decline",
  "review.mine": "You entered this value, so someone else must confirm it.",
  "review.useAsStated": "Use it, stated by me",
  "auth.reviewMode": "How are values reviewed?",
  "auth.mode.solo": "On my own (solo review)",
  "auth.mode.team": "With a team (a second person confirms material values I enter)",
  "review.needsReview": "Needs review",
  "review.approveAll": (p) => `Approve all ${p.n}`,
  "review.approveAllConfirm": (p) => `Approve all ${p.n} values as extracted? Each keeps its source and your name in the audit trail.`,
  "review.col.input": "Input",
  "review.col.value": "Value",
  "review.col.source": "Source",
  "review.agree": (p) => `${p.n} documents agree`,
  "review.approve": "Approve",
  "review.edit": "Edit",
  "review.keep": "Keep…",
  "review.keepHint": "No document states this value any more. To keep it, say why; it becomes your own value.",
  "review.reject": "Reject",
  "review.approved": "Approved",
  "review.defaultAccepted": "Default accepted",
  "review.enteredByShort": (p) => `Entered by ${p.who}`,
  "review.confirmedBy": (p) => ` · confirmed by ${p.who}`,
  "review.confirmedByReview": (p) => ` · Confirmed by Agir review on ${p.date}`,
  "review.statedBy": (p) => `Stated by ${p.who}, not independently confirmed`,
  "review.materialNoteSolo": "Material field: this value is used right away and labelled as stated by you until someone else confirms it.",
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
  "run.draftPolicy": "Draft policy, not signed by credit",
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
  "run.saleCashFlows": "A deal that sells its units has no years of operations. Each month's costs, loans and closings are in the Excel export.",
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
  "run.notConfirmed": "Not independently confirmed",
  "run.confirmedBy": (p) => `Confirmed by ${p.who}`,
  "run.confirmedByReview": (p) => `Confirmed by Agir review on ${p.date}`,
  "run.history": "Run history",
  "run.stale.inputs": "An approved input changed after this run.",
  "run.stale.policy": "The policy thresholds changed after this run.",
  "run.stale.engine": "The engine was updated after this run.",

  "explore.title": "Explore changes",
  "explore.banner": "Exploration, not a run.",
  "explore.bannerBody": (p) => `Every figure here is a re-run of run ${p.n} with your changes. Nothing is saved, and none of it can be exported or decided on.`,
  "explore.noRun": "Explore needs a run to start from.",
  "explore.saleUnavailable": "Trying changes is not yet available for a deal that sells its units.",
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
  "explore.be.title": "What would make each failing gate pass",
  "explore.be.body": "One input at a time: each row moves a single assumption as far as the gate needs, with every other input held at the run's values. Moves together interact, so use the grid to try a mix.",
  "explore.be.hardFail": "This run fails a check that no gate can offset. Passing the gates alone would not change the verdict while it stands.",
  "explore.be.none": "No gate fails in this run.",
  "explore.be.gateNow": (p) => `Run value ${p.v}; the gate needs ${p.t}.`,
  "explore.be.col.input": "Input",
  "explore.be.col.needs": "What it would take",
  "explore.be.col.gate": "Gate figure there",

  "glossary.title": "What these terms mean",
  "glossary.dcr": () => ["DCR (debt coverage ratio), called DSCR by many lenders", "Net operating income divided by the full amortizing loan payment, even during an interest-only period, for the weakest year of the hold."],
  "glossary.noi": () => ["Net operating income (NOI)", "The rent and other income actually collected, less operating costs, before any loan payments."],
  "glossary.capRate": () => ["Cap rate (exit)", "The yield a buyer is assumed to require at sale; the final year's NOI divided by it gives the sale value."],
  "glossary.yieldOnCost": () => ["Yield on cost", "Stabilized NOI divided by the total cost of developing the project."],
  "glossary.loanToCost": () => ["Loan to cost (LTC)", "The share of the total development cost that is financed by loans."],
  "glossary.equityIrr": () => ["Equity IRR", "The annual rate of return on the equity put in, taking into account when each payment in and out happens."],
  "glossary.equityMultiple": () => ["Equity multiple", "All the cash paid back to equity divided by all the equity put in; 2.0x means twice what was invested."],
  "glossary.breakEven": () => ["Break-even occupancy", "The share of the potential rent that must be collected in year 1 to cover fixed operating costs, variable costs and loan payments."],

  "decision.noRun": "There is no run to decide on yet.",
  "decision.noRunBody": "A committee decision is always recorded against a specific run.",
  "decision.noRunBodySolo": "Your decision is always recorded against a specific run.",
  "decision.goRun": "Go to Run",
  "decision.recorded": "Recorded decisions",
  "decision.conditions": (p) => `Conditions: ${p.c}`,
  "decision.against": (p) => `Decided against the ${p.v} verdict because: ${p.r}`,
  "decision.permanent": "permanent record",
  "decision.cannot": "A decision cannot be recorded right now.",
  "decision.stale": "The inputs changed after this run. Run underwriting again first.",
  "decision.role": "Only a workspace admin or owner records committee decisions.",
  "decision.roleSolo": "Only a workspace admin or owner records a decision.",
  "decision.further": "Record a further decision",
  "decision.title": "Committee decision",
  "decision.titleSolo": "Your decision",
  "decision.reasoning": "The committee's reasoning",
  "decision.reasoningSolo": "Your reasoning",
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
  "reports.buildDecision": "Build decision",
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
  "settings.r.reviewer": "Reads the workspace and confirms values stated by someone else, for a limited time. Changes nothing else.",
  "settings.r.analyst": "Uploads documents, reviews values, runs underwriting, generates reports.",
  "settings.r.admin": "Everything an analyst can do, plus committee decisions and adding people.",
  "settings.r.owner": "Everything an admin can do. Created the workspace.",
  "settings.newWs": "New workspace",
  "settings.create": "Create",
  "settings.reviewMode": "Review mode",
  "settings.mode.team": "Team review",
  "settings.mode.teamBody": "A material value entered by hand waits for a second person.",
  "settings.mode.solo": "Solo review",
  "settings.suggest": "Label suggestions",
  "settings.suggestOn": "Let a model suggest labels",
  "settings.suggestNotice": "When this is on, the text around each figure Agir could not label is sent to Anthropic's Claude API, which processes it in the United States. A suggested label is never approved by itself.",
  "settings.mode.soloBody": "Values you enter are used right away and labelled as stated by you until someone else confirms them.",
  "settings.review": "Request Agir review",
  "settings.reviewBody": "Give an Agir reviewer time-limited access to confirm the values you stated. They can read the workspace and confirm values, nothing else.",
  "settings.reviewDays": "Days of access",
  "settings.reviewBtn": "Request review",
  "settings.expires": (p) => `until ${p.date}`,
  "settings.expired": "expired",
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
  "deals.summarySolo": (p) => `${p.blocked} ${s(p.blocked, "projet est bloqué", "projets sont bloqués")}. ${p.ready} ${s(p.ready, "est prêt", "sont prêts")} pour votre décision.`,
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
  "copy.button": "Copier comme variante",
  "copy.title": "Copier comme variante",
  "copy.intro": "Une variante est une copie de ce projet dans exactement son état\u00a0: les mêmes documents, valeurs et approbations. Modifiez-la et lancez une analyse pour comparer un scénario. Les analyses, décisions et rapports restent avec ce projet.",
  "copy.name": "Nom de la variante",
  "copy.suffix": ", variante",
  "copy.create": "Copier et ouvrir",
  "copy.variantOf": "Variante de",
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
  "status.outOfRange": (p) => `${p.n} à corriger`,
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
  "next.decideSolo": "Consigner votre décision",
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
  "review.updating": "Mise à jour de l'examen à partir de vos documents…",
  "review.stillReadingBody": "Les valeurs apparaîtront ici à mesure que chaque document est terminé.",
  "review.suggested": "Libellé suggéré, à confirmer",
  "review.useAs": "Utiliser comme…",
  "review.useAsField": "Champ",
  "review.useAsPick": "Choisir un champ",
  "review.useAsItem": "Nom de l'élément",
  "review.labelledAs": (p) => `Libellé « ${p.field} » par ${p.who}`,
  "review.undo": "Annuler",
  "review.unusedLine": (p) => `${p.n} ${s(p.n, "chiffre", "chiffres")} de vos documents ${s(p.n, "n'a pas été utilisé", "n'ont pas été utilisés")}. Vous pouvez en libeller un comme donnée.`,
  "review.unusedLink": "Afficher les chiffres",
  "review.fromM2": "Le document l'indique en mètres carrés. Agir travaille en pieds carrés et l'a converti.",
  "review.statedIn": (p) => `Le document l'indique en ${p.code}. Il est affiché ici, mais jamais utilisé.`,
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
  "review.b.impossible": (p) => `${p.n} ${s(p.n, "donnée doit être corrigée", "données doivent être corrigées")}`,
  "review.impossible": "Ces données ne peuvent pas être analysées ensemble",
  "review.b.tail": ". Agir ne choisira ni ne complétera aucune valeur à votre place.",
  "review.clear": "L'examen est terminé.",
  "review.clearBody": "Chaque donnée requise est approuvée ou constitue une valeur par défaut nommée. Passez à l'analyse.",
  "review.statedWaiting": (p) => (p.n === 1 ? "Une valeur a été déclarée par une seule personne et n'est pas confirmée de façon indépendante ; elle figure sous Approuvées." : `${p.n} valeurs ont été déclarées par une seule personne et ne sont pas confirmées de façon indépendante ; elles figurent sous Approuvées.`),
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
  "qs.title": "Démarrage rapide",
  "qs.intro": "Pas de documents ? Répondez à quelques questions simples pour obtenir un projet analysable. Chaque réponse est consignée avec sa provenance.",
  "qs.template": "Que construisez-vous ?",
  "qs.t.multiplex": "Multiplex locatif (2–4 logements)",
  "qs.t.apartment": "Petit immeuble d'appartements (5–30 logements)",
  "qs.t.townhomes": "Maisons en rangée à vendre (2 à 30 logements)",
  "qs.saleLine": "Ces logements sont vendus, et non loués.",
  "qs.unitSalePrice": "Prix de vente par logement",
  "qs.doneSales": "Vos réponses sont enregistrées.",
  "qs.saleGstQuestion": "Combien coûtera la TPS/TVH, nette des remboursements ?",
  "qs.optional": "facultatif",
  "qs.sell": "Le vendre",
  "qs.keep": "Le conserver et le refinancer",
  "qs.amortUnused": "non requis : le prêt est à intérêts seulement jusqu'au refinancement",
  "qs.errRefinance": "Indiquez le montant du prêt de refinancement ou son ratio prêt-valeur, pas les deux.",
  "qs.unitType": "Type de logement, p. ex. 2 chambres",
  "qs.unitCount": "Combien de ce type ?",
  "qs.unitRent": "Loyer mensuel par logement",
  "qs.addType": "Ajouter un type de logement",
  "qs.removeType": "Retirer ce type de logement",
  "qs.reason": "D'où viennent ces chiffres ? (consigné dans la piste d'audit)",
  "qs.reasonDefault": "Indiqué dans le démarrage rapide",
  "qs.defaultsTitle": "Hypothèses courantes",
  "qs.defaultsBody": "Ces hypothèses courantes seront utilisées. Acceptez-les, ou modifiez-les plus tard à l'étape Examen.",
  "qs.accept": "Accepter ces valeurs par défaut",
  "qs.defaultLine": (p) => `${p.label} : ${p.value}`,
  "qs.hidden": "Non demandé",
  "qs.hiddenLine": (p) => `Non demandé : ${p.label}, ce qui signifie ${p.means}`,
  "qs.submit": "Enregistrer mes réponses",
  "qs.working": "Enregistrement…",
  "qs.errUnits": (p) => `Ce type de projet compte de ${p.min} à ${p.max} logements au total.`,
  "qs.errName": "Nommez chaque type de logement.",
  "qs.errPipe": "Le nom d'un type de logement ne peut pas contenir « | ».",
  "qs.errDup": "Chaque type de logement doit avoir un nom différent.",
  "qs.errRange": (p) => `${p.label} doit se situer entre ${p.min} et ${p.max}.`,
  "qs.errWhole": (p) => `${p.label} doit être un nombre entier.`,
  "qs.errAccept": "Cochez la case pour accepter les hypothèses courantes.",
  "qs.errReason": "Indiquez d'où viennent les chiffres (au moins 10 caractères).",
  "qs.done": "Vos réponses sont enregistrées et les hypothèses courantes sont acceptées.",
  "qs.next": "Passer à l'examen, puis à l'analyse",
  "review.materialNote": "Champ déterminant : une seconde personne, différente, doit confirmer cette valeur avant qu'elle compte.",
  "review.saveValue": "Enregistrer la valeur",
  "review.missing": "Données manquantes",
  "review.nMissing": (p) => `${p.n} ${s(p.n, "manquante", "manquantes")}`,
  "review.acceptDefaults": (p) => `Accepter ${p.n} ${s(p.n, "valeur par défaut", "valeurs par défaut")}`,
  "review.missingBody": (p) =>
    `Aucun document ne les indique. Saisissez chaque valeur et précisez sa provenance${p.defaults ? ", ou acceptez les valeurs par défaut nommées, que chaque rapport divulguera" : ""}.`,
  "review.notFound": "Introuvable dans les documents",
  "review.notFoundBody": "Aucun document ne les indique, ou Agir n'a pas pu les lire. Elles ne sont pas saisies comme valeurs. Si vous en avez une, saisissez-la et précisez sa provenance.",
  "review.notFoundLine": (p) => `${p.field} \u2014 introuvable. L'analyse considère\u00a0: ${p.meaning}.`,
  "review.notFoundEnter": "Saisir une valeur",
  "review.choices": "Choix qui vous reviennent",
  "review.choicesBody": "Agir ne lit jamais ces choix dans les documents. Si vous en laissez un, l'analyse retient ce qui est indiqué.",
  "review.choiceLine": (p) => `${p.field}\u00a0: non précisé. L'analyse considère\u00a0: ${p.meaning}.`,
  "review.choiceEnter": "Faire ce choix",
  "review.default": (p) => ` · par défaut ${p.v}`,
  "review.materialTag": " · déterminant",
  "review.sourceFor": (p) => `Source de ${p.label}`,
  "review.sourceHint": "Source ou justification, p. ex. appel avec le promoteur le 12 sept.",
  "review.addItem": "Ajouter un type de logement ou d'espace",
  "review.addItemName": "Nom, p. ex. 3 chambres ou Commerce",
  "review.addItemPerUnit": "Loyer par logement",
  "review.addItemPerSf": "Loyer au pied carré",
  "review.awaiting": "En attente d'un second approbateur",
  "review.enteredBy": (p) => `saisie par ${p.who}${p.old ? `, en remplacement de ${p.old}` : ""}`,
  "review.reason": (p) => `Justification : ${p.r}`,
  "review.confirm": "Confirmer comme second approbateur",
  "review.decline": "Refuser",
  "review.mine": "Vous avez saisi cette valeur ; une autre personne doit la confirmer.",
  "review.useAsStated": "L'utiliser, déclarée par moi",
  "auth.reviewMode": "Comment les valeurs sont-elles examinées ?",
  "auth.mode.solo": "Seul(e) (examen individuel)",
  "auth.mode.team": "En équipe (une seconde personne confirme les valeurs déterminantes que je saisis)",
  "review.needsReview": "À examiner",
  "review.approveAll": (p) => `Tout approuver (${p.n})`,
  "review.approveAllConfirm": (p) => `Approuver les ${p.n} valeurs telles qu'extraites ? Chacune conserve sa source et votre nom dans la piste d'audit.`,
  "review.col.input": "Donnée",
  "review.col.value": "Valeur",
  "review.col.source": "Source",
  "review.agree": (p) => `${p.n} documents concordent`,
  "review.approve": "Approuver",
  "review.edit": "Modifier",
  "review.keep": "Conserver…",
  "review.keepHint": "Aucun document n'indique plus cette valeur. Pour la conserver, dites pourquoi ; elle devient votre propre valeur.",
  "review.reject": "Rejeter",
  "review.approved": "Approuvées",
  "review.defaultAccepted": "Valeur par défaut acceptée",
  "review.enteredByShort": (p) => `Saisie par ${p.who}`,
  "review.confirmedBy": (p) => ` · confirmée par ${p.who}`,
  "review.confirmedByReview": (p) => ` · Confirmée par la révision Agir le ${p.date}`,
  "review.statedBy": (p) => `Déclarée par ${p.who}, non confirmée de façon indépendante`,
  "review.materialNoteSolo": "Champ déterminant : cette valeur est utilisée tout de suite et marquée comme déclarée par vous jusqu'à ce qu'une autre personne la confirme.",
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
  "run.draftPolicy": "Politique provisoire, non approuvée par le crédit",
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
  "run.saleCashFlows": "Un projet qui vend ses logements n'a pas d'années d'exploitation. Les coûts, les prêts et les ventes conclues de chaque mois figurent dans l'export Excel.",
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
  "run.notConfirmed": "Non confirmée de façon indépendante",
  "run.confirmedBy": (p) => `Confirmée par ${p.who}`,
  "run.confirmedByReview": (p) => `Confirmée par la révision Agir le ${p.date}`,
  "run.history": "Historique des analyses",
  "run.stale.inputs": "Une donnée approuvée a changé après cette analyse.",
  "run.stale.policy": "Les seuils de la politique ont changé après cette analyse.",
  "run.stale.engine": "Le moteur a été mis à jour après cette analyse.",

  "explore.title": "Explorer des variantes",
  "explore.banner": "Exploration, pas une analyse.",
  "explore.bannerBody": (p) => `Chaque chiffre ici est un nouveau calcul de l'analyse ${p.n} avec vos changements. Rien n'est enregistré, et rien ne peut être exporté ni servir à une décision.`,
  "explore.noRun": "L'exploration part d'une analyse existante.",
  "explore.saleUnavailable": "L'essai de modifications n'est pas encore offert pour un projet qui vend ses logements.",
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
  "explore.be.title": "Ce qui ferait réussir chaque critère non atteint",
  "explore.be.body": "Une hypothèse à la fois : chaque ligne déplace une seule hypothèse aussi loin que le critère l'exige, toutes les autres restant aux valeurs de l'analyse. Les changements combinés interagissent ; utilisez la grille pour essayer un mélange.",
  "explore.be.hardFail": "Cette analyse échoue à une vérification qu'aucun critère ne peut compenser. Réussir les critères seuls ne changerait pas le verdict tant qu'elle subsiste.",
  "explore.be.none": "Aucun critère n'est en échec dans cette analyse.",
  "explore.be.gateNow": (p) => `Valeur de l'analyse ${p.v} ; le critère exige ${p.t}.`,
  "explore.be.col.input": "Hypothèse",
  "explore.be.col.needs": "Ce qu'il faudrait",
  "explore.be.col.gate": "Chiffre du critère à ce point",

  "glossary.title": "Ce que ces termes veulent dire",
  "glossary.dcr": () => ["CCD (coefficient de couverture de la dette), appelé RCSD par de nombreux prêteurs", "Le revenu net d'exploitation divisé par le paiement complet d'un prêt amorti, même pendant une période d'intérêts seulement, pour l'année la plus faible de la détention."],
  "glossary.noi": () => ["Revenu net d'exploitation (RNE)", "Les loyers et autres revenus réellement encaissés, moins les charges d'exploitation, avant tout paiement de prêt."],
  "glossary.capRate": () => ["Taux de capitalisation (sortie)", "Le rendement qu'un acheteur est supposé exiger à la vente ; le RNE de la dernière année divisé par ce taux donne la valeur de vente."],
  "glossary.yieldOnCost": () => ["Rendement sur coût", "Le RNE stabilisé divisé par le coût total de développement du projet."],
  "glossary.loanToCost": () => ["Ratio prêt-coût", "La part du coût total de développement qui est financée par des prêts."],
  "glossary.equityIrr": () => ["TRI des fonds propres", "Le taux de rendement annuel des fonds propres investis, selon le moment de chaque versement et de chaque distribution."],
  "glossary.equityMultiple": () => ["Multiple des fonds propres", "Tout l'argent rendu aux fonds propres divisé par tous les fonds propres investis ; 2,0x veut dire le double de la mise."],
  "glossary.breakEven": () => ["Occupation au seuil de rentabilité", "La part des loyers potentiels qui doit être encaissée à l'année 1 pour couvrir les charges fixes, les charges variables et les paiements de prêt."],

  "decision.noRun": "Il n'y a pas encore d'analyse sur laquelle décider.",
  "decision.noRunBody": "Une décision du comité est toujours consignée pour une analyse précise.",
  "decision.noRunBodySolo": "Votre décision est toujours consignée pour une analyse précise.",
  "decision.goRun": "Aller à l'analyse",
  "decision.recorded": "Décisions consignées",
  "decision.conditions": (p) => `Conditions : ${p.c}`,
  "decision.against": (p) => `Décision contraire au verdict « ${p.v} », parce que : ${p.r}`,
  "decision.permanent": "registre permanent",
  "decision.cannot": "Aucune décision ne peut être consignée pour l'instant.",
  "decision.stale": "Les données ont changé après cette analyse. Relancez d'abord l'analyse.",
  "decision.role": "Seul un administrateur ou le propriétaire de l'espace consigne les décisions du comité.",
  "decision.roleSolo": "Seul un administrateur ou le propriétaire de l'espace consigne une décision.",
  "decision.further": "Consigner une autre décision",
  "decision.title": "Décision du comité",
  "decision.titleSolo": "Votre décision",
  "decision.reasoning": "Motifs du comité",
  "decision.reasoningSolo": "Vos motifs",
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
  "reports.buildDecision": "Décision de construire",
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
  "settings.r.reviewer": "Consulte l'espace et confirme les valeurs déclarées par une autre personne, pour une durée limitée. Ne modifie rien d'autre.",
  "settings.r.analyst": "Téléverse des documents, examine les valeurs, lance les analyses, produit les rapports.",
  "settings.r.admin": "Tout ce que fait un analyste, plus les décisions du comité et l'ajout de personnes.",
  "settings.r.owner": "Tout ce que fait un administrateur. A créé l'espace.",
  "settings.newWs": "Nouvel espace de travail",
  "settings.create": "Créer",
  "settings.reviewMode": "Mode d'examen",
  "settings.mode.team": "Examen en équipe",
  "settings.mode.teamBody": "Une valeur déterminante saisie à la main attend une seconde personne.",
  "settings.mode.solo": "Examen individuel",
  "settings.suggest": "Suggestions de libellés",
  "settings.suggestOn": "Laisser un modèle suggérer des libellés",
  "settings.suggestNotice": "Lorsque cette option est activée, le texte entourant chaque chiffre qu'Agir n'a pas pu libeller est envoyé à l'API Claude d'Anthropic, qui le traite aux États-Unis. Un libellé suggéré n'est jamais approuvé automatiquement.",
  "settings.mode.soloBody": "Les valeurs que vous saisissez sont utilisées tout de suite et marquées comme déclarées par vous jusqu'à ce qu'une autre personne les confirme.",
  "settings.review": "Demander une révision Agir",
  "settings.reviewBody": "Donnez à un réviseur Agir un accès limité dans le temps pour confirmer les valeurs que vous avez déclarées. Il peut consulter l'espace et confirmer des valeurs, rien d'autre.",
  "settings.reviewDays": "Jours d'accès",
  "settings.reviewBtn": "Demander la révision",
  "settings.expires": (p) => `jusqu'au ${p.date}`,
  "settings.expired": "expiré",
  "settings.language": "Langue",
  "settings.languageBody": "L'interface et ses nombres suivent ce choix. Il est mémorisé sur cet appareil.",
};

// ---- Catalog labels in French ------------------------------------------------------------
const FR_FIELDS: Record<string, string> = {
  sell_units: "Vendre les logements (sans location)", unit_sale_price: "Prix de vente par logement", presold_units_pct: "Logements prévendus",
  deposit_pct: "Dépôt de l'acheteur", absorption_units_per_month: "Rythme de vente (logements par mois)", sales_commission_pct: "Commission de vente",
  closing_lag_months: "Mois entre l'achèvement et la première conclusion de vente", unsold_carry_monthly: "Frais de possession par logement non vendu par mois",
  senior_presale_threshold_pct: "Seuil de préventes du prêteur",
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
  refinance_and_hold: "Conserver et refinancer (sans vente)", refinance_io_months: "Période d'intérêts seulement (refinancement)", lp_share_pct: "Part des commanditaires", preferred_return_pct: "Rendement privilégié",
  gp_promote_pct: "Intéressement du commandité au-delà du rendement privilégié", stated_total_cost: "Coût total déclaré du projet",
  stated_ltc_pct: "Ratio prêt-coût déclaré", stated_interest_reserve: "Réserve d'intérêts déclarée",
  development_charges: "Redevances de développement", land_transfer_tax: "Droits de mutation immobilière", gst_hst_net: "TPS/TVH nette des remboursements",
  property_tax_annual: "Taxe foncière (par année)", refinance_insurance_premium_pct: "Prime d'assurance hypothécaire du refinancement",
};
const FR_HELP: Record<string, string> = {
  unit_sale_price: "Net de TPS/TVH et de tout remboursement conservé par le constructeur.",
  contingency: "Saisissez 0 si le budget n'en prévoit pas.",
  other_cost: "Saisissez un vrai crédit (remise, remboursement) sous forme de montant négatif, avec le motif.",
  lease_up_months: "Saisissez 0 si l'actif est stabilisé dès la fin des travaux.",
  expense_ratio_pct: "Part du RBE de l'année 1, maintenue en dollars fixes et indexée selon la croissance des charges.",
  senior_loan_amount: "Saisissez 0 pour un projet financé entièrement par fonds propres.",
  development_charges: "Si vos coûts indirects ou autres coûts les incluent déjà, ne les saisissez pas.",
  land_transfer_tax: "Si vos coûts indirects ou autres coûts les incluent déjà, ne les saisissez pas.",
  gst_hst_net: "Si vos coûts indirects ou autres coûts l'incluent déjà, ne la saisissez pas.",
  property_tax_annual: "Ne la saisissez pas si votre ratio des charges ou vos charges d'exploitation fixes l'incluent déjà.",
  refinance_insurance_premium_pct: "La prime est ajoutée au prêt de refinancement. Ne la saisissez pas s'il n'y a pas d'assurance hypothécaire.",
};
const FR_ABSENT: Record<string, string> = {
  sell_units: "les logements sont loués",
  senior_presale_threshold_pct: "aucune condition de préventes déclarée",
  other_cost: "aucun autre coût",
  unit_rent_monthly: "le loyer est au pied carré",
  rentable_area_sf: "le loyer est par logement",
  rent_psf_annual: "le loyer est par logement",
  item_occupancy_pct: "utiliser l'occupation stabilisée du projet",
  fixed_opex_annual: "utiliser le ratio des charges",
  variable_expense_pct: "aucune charge variable",
  other_income_annual: "aucun autre revenu",
  rent_growth_pct: "loyers stables",
  expense_growth_pct: "charges stables",
  lease_up_ramp: "aucun revenu avant la stabilisation",
  s_curve_draws: "tirages linéaires",
  senior_io_months: "amortissement dès la stabilisation",
  min_dscr_covenant: "aucune clause déclarée",
  mezz_loan_amount: "aucun prêt mezzanine",
  mezz_io_months: "amortissement dès la stabilisation",
  equity_amount: "les fonds propres couvrent ce que la dette ne finance pas",
  refinance_month: "aucun refinancement",
  refinance_amount: "établi selon le ratio prêt-valeur",
  refinance_ltv_pct: "établi selon le montant",
  refinance_io_months: "amortissement dès le refinancement",
  refinance_and_hold: "le projet est vendu à la fin de la détention",
  development_charges: "aucune redevance déclarée",
  land_transfer_tax: "aucun droit déclaré",
  gst_hst_net: "aucune déclarée",
  property_tax_annual: "comprise dans les charges d'exploitation, ou aucune",
  refinance_insurance_premium_pct: "aucune assurance hypothécaire",
  lp_share_pct: "aucun partage entre commanditaires et commandité",
  stated_total_cost: "rien à vérifier",
  stated_ltc_pct: "rien à vérifier",
  stated_interest_reserve: "rien à vérifier",
};
// Quick-start questions: [question, hint] in English and in French, by field key.
const ASK: Record<string, [[string, string?], [string, string?]]> = {
  sell_units: [["Will you sell the units instead of renting them?"], ["Vendrez-vous les logements au lieu de les louer ?"]],
  unit_sale_price: [["What is the sale price per unit?", "Net of GST/HST and any rebate the builder keeps."], ["Quel est le prix de vente par logement ?", "Net de TPS/TVH et de tout remboursement conservé par le constructeur."]],
  presold_units_pct: [["What percentage of units is presold?", "Enter 0 if none are presold."], ["Quel pourcentage des logements est prévendu ?", "Saisissez 0 si aucun n'est prévendu."]],
  deposit_pct: [["What percentage of the price is the buyer's deposit?", "Enter 0 if there is no deposit. Deposits stay in trust and do not fund costs."], ["Quel pourcentage du prix représente le dépôt de l'acheteur ?", "Saisissez 0 s'il n'y a pas de dépôt. Les dépôts restent en fiducie et ne financent pas les coûts."]],
  absorption_units_per_month: [["How many units will sell per month?", "A fraction is allowed, such as 0.5 for one unit every two months."], ["Combien de logements seront vendus par mois ?", "Une fraction est permise, comme 0,5 pour un logement tous les deux mois."]],
  sales_commission_pct: [["What percentage of sales pays the commission?", "Enter 0 if there is no commission."], ["Quel pourcentage des ventes paie la commission ?", "Saisissez 0 s'il n'y a pas de commission."]],
  closing_lag_months: [["How many months from completion to the first closing?", "Enter 0 for a freehold townhome that closes at completion."], ["Combien de mois entre l'achèvement et la première conclusion de vente ?", "Saisissez 0 pour une maison en rangée en pleine propriété dont la vente est conclue à l'achèvement."]],
  unsold_carry_monthly: [["What will each unsold unit cost to carry per month?", "Enter 0 if there are no carrying costs."], ["Quels seront les frais de possession mensuels par logement non vendu ?", "Saisissez 0 s'il n'y a pas de frais de possession."]],
  senior_presale_threshold_pct: [["What percentage of units must be presold for the loan?", "Leave blank if no presale condition is stated."], ["Quel pourcentage des logements doit être prévendu pour le prêt ?", "Laissez vide si aucune condition de préventes n'est déclarée."]],
  land_cost: [["What did you pay, or will you pay, for the land?", "Include the purchase price only; closing costs go in soft costs."], ["Combien avez-vous payé, ou paierez-vous, pour le terrain ?", "Le prix d'achat seulement ; les frais de clôture vont dans les coûts indirects."]],
  hard_cost: [["What will construction cost?", "Labour and materials, from your builder's quote or estimate."], ["Combien coûteront les travaux de construction ?", "Main-d'œuvre et matériaux, selon la soumission ou l'estimation de l'entrepreneur."]],
  soft_cost: [["What will design, permits, fees and legal cost?", "Everything that is not land or construction."], ["Combien coûteront la conception, les permis, les frais et les services juridiques ?", "Tout ce qui n'est ni le terrain ni la construction."]],
  contingency: [["How much have you set aside for cost overruns?", "Enter 0 if you have set nothing aside."], ["Quelle somme avez-vous prévue pour les dépassements de coûts ?", "Saisissez 0 si vous n'avez rien prévu."]],
  other_cost: [["Any other project costs?", "Leave blank if there are none."], ["D'autres coûts de projet ?", "Laissez vide s'il n'y en a pas."]],
  construction_months: [["How many months will construction take?", "Enter 0 if the building is already built."], ["Combien de mois dureront les travaux ?", "Saisissez 0 si l'immeuble est déjà construit."]],
  lease_up_months: [["How many months to fill the building after it is finished?", "Enter 0 if it is rented from day one."], ["Combien de mois pour remplir l'immeuble une fois terminé ?", "Saisissez 0 s'il est loué dès le premier jour."]],
  unit_count: [["How many units are there?"], ["Combien y a-t-il de logements ?"]],
  unit_rent_monthly: [["What rent will each unit get per month?"], ["Quel loyer mensuel chaque logement obtiendra-t-il ?"]],
  stabilized_occupancy_pct: [["Once full, what share of the year will units be rented?", "95 means about 5% vacancy."], ["Une fois l'immeuble rempli, quelle part de l'année les logements seront-ils loués ?", "95 signifie une vacance d'environ 5 %."]],
  other_income_annual: [["Any other income per year, such as parking or laundry?", "Leave blank if there is none."], ["D'autres revenus par année, comme le stationnement ou la buanderie ?", "Laissez vide s'il n'y en a pas."]],
  exit_cap_rate_pct: [["At what cap rate would a buyer value the finished building?", "Ask a broker if unsure; a higher rate means a lower value."], ["À quel taux de capitalisation un acheteur évaluerait-il l'immeuble terminé ?", "Demandez à un courtier au besoin ; un taux plus élevé donne une valeur plus basse."]],
  senior_loan_amount: [["How much will the lender advance?", "Enter 0 if you are not borrowing."], ["Quelle somme le prêteur avancera-t-il ?", "Saisissez 0 si vous n'empruntez pas."]],
  senior_rate_pct: [["What is the loan's interest rate?"], ["Quel est le taux d'intérêt du prêt ?"]],
  senior_amort_years: [["Over how many years is the loan paid down?"], ["Sur combien d'années le prêt est-il amorti ?"]],
  refinance_and_hold: [["How will this deal end?"], ["Comment ce projet se terminera-t-il ?"]],
  senior_io_months: [["For how many months is the construction loan interest-only?", "Enter 0 if there is no interest-only period."], ["Pendant combien de mois le prêt de construction est-il à intérêts seulement ?", "Saisissez 0 s'il n'y a pas de période à intérêts seulement."]],
  refinance_month: [["In which month will you refinance?", "Count from the start of the project."], ["À quel mois refinancerez-vous ?", "Comptez à partir du début du projet."]],
  refinance_amount: [["What will the refinance loan amount be?", "Give this amount or the loan-to-value below, not both."], ["Quel sera le montant du prêt de refinancement ?", "Indiquez ce montant ou le ratio prêt-valeur ci-dessous, pas les deux."]],
  refinance_ltv_pct: [["What loan-to-value will the refinance use?", "Give this percentage or the loan amount above, not both."], ["Quel ratio prêt-valeur sera utilisé pour le refinancement ?", "Indiquez ce pourcentage ou le montant du prêt ci-dessus, pas les deux."]],
  refinance_rate_pct: [["What is the refinance loan's interest rate?"], ["Quel est le taux d'intérêt du prêt de refinancement ?"]],
  refinance_amort_years: [["Over how many years is the refinance loan paid down?"], ["Sur combien d'années le prêt de refinancement est-il amorti ?"]],
  refinance_io_months: [["For how many months is the refinance loan interest-only?", "Leave blank if there is no interest-only period."], ["Pendant combien de mois le prêt de refinancement est-il à intérêts seulement ?", "Laissez vide s'il n'y a pas de période à intérêts seulement."]],
  refinance_insurance_premium_pct: [["What is the refinance mortgage insurance premium?", "For an insured (CMHC) loan. Leaving this blank means no mortgage insurance."], ["Quelle est la prime d'assurance hypothécaire du refinancement ?", "Pour un prêt assuré (SCHL). Laisser ce champ vide signifie aucune assurance hypothécaire."]],
  development_charges: [["What will development charges (DCs or DCCs) cost?", "Enter 0 if there are none, or if your soft or other costs already include them."], ["Combien coûteront les redevances de développement ?", "Saisissez 0 s'il n'y en a pas, ou si vos coûts indirects ou autres coûts les incluent déjà."]],
  property_tax_annual: [["What will property tax cost per year?", "Enter 0 if there is none, or if your expense ratio or fixed operating costs already include it."], ["Combien coûtera la taxe foncière par année ?", "Saisissez 0 s'il n'y en a pas, ou si votre ratio des charges ou vos charges d'exploitation fixes l'incluent déjà."]],
  land_transfer_tax: [["What will land transfer tax cost?", "Leave blank if there is none, or if your soft or other costs already include it."], ["Combien coûteront les droits de mutation immobilière ?", "Laissez vide s'il n'y en a pas, ou si vos coûts indirects ou autres coûts les incluent déjà."]],
  gst_hst_net: [["What will GST/HST cost, net of the rental rebates?", "Leave blank if there is none, or if your soft or other costs already include it."], ["Combien coûtera la TPS/TVH, nette des remboursements pour logement locatif ?", "Laissez vide s'il n'y en a pas, ou si vos coûts indirects ou autres coûts l'incluent déjà."]],
};
const GROUPS: Record<string, [string, string]> = {
  sale: ["Unit sales", "Ventes des unités"],
  budget: ["Budget", "Budget"], revenue: ["Revenue", "Revenus"], timeline: ["Timeline", "Échéancier"], operations: ["Operations", "Exploitation"],
  exit: ["Exit", "Sortie"], senior: ["Senior loan", "Prêt principal"], mezzanine: ["Mezzanine loan", "Prêt mezzanine"], equity: ["Equity", "Fonds propres"],
  refinance: ["Refinance", "Refinancement"], waterfall: ["LP/GP split", "Partage commanditaires-commandité"], stated: ["Stated figures (checks)", "Chiffres déclarés (contrôles)"],
};
const FR_METRICS: Record<string, [string, string]> = {
  gross_sales_revenue: ["Revenu brut des ventes", "logements × prix de vente, pour chaque type de logement"],
  net_sales_revenue: ["Revenu net des ventes", "revenu brut des ventes − commission de vente"],
  interest_before_completion: ["Intérêts pendant la construction", "intérêts sur les prêts avant l'achèvement, peu importe qui les paie"],
  interest_after_completion: ["Intérêts après l'achèvement", "intérêts ajoutés aux prêts de l'achèvement jusqu'à leur remboursement"],
  carry_total: ["Frais de possession des logements non vendus", "frais par logement par mois × logements achevés dont la vente n'est pas encore conclue"],
  development_profit_for_sale: ["Profit de développement (logements vendus)", "revenu net des ventes − coût total de développement − frais de possession − intérêts après l'achèvement"],
  profit_on_cost_for_sale: ["Profit sur coût (logements vendus)", "profit de développement / (coût total de développement + frais de possession + intérêts après l'achèvement)"],
  margin_on_revenue: ["Marge sur le revenu des ventes", "profit de développement / revenu net des ventes"],
  equity_contributed: ["Fonds propres apportés", "chaque apport de fonds propres, frais de possession compris"],
  equity_distributed: ["Fonds propres récupérés", "produit des ventes restant après le remboursement des prêts"],
  completion_month: ["Achèvement (mois)", "la durée de construction"],
  sellout_month: ["Dernière conclusion de vente (mois)", "le mois où la vente du dernier logement est conclue"],
  sellout_years: ["Durée pour tout vendre", "(mois de la dernière conclusion de vente + 1) / 12"],
  deposits_held_at_completion: ["Dépôts des acheteurs en fiducie à l'achèvement", "logements prévendus × prix moyen × pourcentage de dépôt ; en fiducie, jamais utilisés pour les coûts"],
  senior_balance_at_completion: ["Solde du prêt principal à l'achèvement", "dette principale tirée et ses intérêts à l'achèvement"],
  mezz_balance_at_completion: ["Solde de la mezzanine à l'achèvement", "dette mezzanine tirée et ses intérêts à l'achèvement"],
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
  leaseup_operating_cost: ["Coûts d'exploitation pendant la location initiale", "coûts d'exploitation fixes, aux niveaux de l'année 1, pour chaque mois de location initiale, imputés au coût total de développement lorsque les revenus de la location initiale ne sont pas comptés"],
  io_dscr_year1: ["RCSD à intérêts seulement (année 1)", "RNE de l'année 1 / service de la dette à intérêts seulement sur les soldes du prêt principal et mezzanine à la stabilisation"],
  cumulative_cash_shortfall: ["Déficit de trésorerie cumulé après la stabilisation", "somme, sur la période de détention, des flux mensuels négatifs après le service de la dette, en montant positif"],
  mezz_interest_accrued: ["Intérêts de la mezzanine courus au-delà de l'engagement", "intérêts de la mezzanine avant la stabilisation, au-delà de son engagement, ajoutés au solde de la mezzanine"],
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
  refinance_premium_added: ["Prime d'assurance hypothécaire ajoutée au prêt de refinancement", "montant du prêt de refinancement x prime en %"],
  cost_per_unit: ["Coût par logement", "coût total de développement / logements"],
  lp_irr: ["TRI des commanditaires", "TRI de la part des commanditaires après la cascade"],
  gp_irr: ["TRI du commandité", "TRI de la part du commandité après la cascade"],
  gp_promote: ["Intéressement du commandité", "distributions du commandité au-delà de sa quote-part"],
  stabilization_month: ["Mois de stabilisation", "construction + période de location"],
  sale_month: ["Mois de la vente", "stabilisation + 12 x années de détention - 1"],
  refinance_cash_returned: ["Encaisse remise au refinancement", "nouveau prêt - remboursement du solde du prêt principal ; un montant négatif signifie qu'il a fallu injecter des fonds"],
  cash_left_in_deal: ["Encaisse restée dans le projet", "fonds propres requis - encaisse remise au refinancement ; 0 ou moins signifie que tous les fonds propres ont été récupérés"],
  dcr_after_refinance: ["Couverture après refinancement (RCSD)", "RNE des 12 mois suivant le mois du refinancement / service de la dette amortissable de toute la dette en vigueur durant ces mois"],
  cash_on_cash_after_refinance: ["Rendement en espèces après refinancement", "(RNE - service de la dette réellement dû) sur les 12 mois suivant le refinancement / encaisse restée dans le projet"],
  stated_value: ["Valeur déclarée (non réalisée, pas une vente)", "RNE de la dernière année de détention / taux de sortie, sans frais de vente"],
  unrealized_equity_multiple: ["Multiple des fonds propres (non réalisé, pas une vente)", "(distributions d'exploitation + refinancement + distribution non réalisée) / apports"],
  unrealized_equity_irr: ["TRI des fonds propres (non réalisé, pas une vente)", "taux qui annule la VAN des flux datés des fonds propres, avec le flux non réalisé"],
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
  dcr_after_refinance: ["Coverage after refinance (DCR)", "Couverture après refinancement (RCSD)"],
  stressed_unrealized_equity_multiple: ["Equity multiple (unrealized, not a sale), combined stress", "Multiple des fonds propres (non réalisé, pas une vente), stress combiné"],
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
const BE_UNIT: Record<string, string> = { rentPct: "%", costPct: "%", exitCapBps: "bps", rateBps: "bps", occupancyPts: "pts" };
type BreakevenText = { driver: string; state: string; shock: number | null; limit: number; to: { key: string; item?: string; to: number; unit: string }[] };
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
  owner: ["owner", "propriétaire"], admin: ["admin", "administrateur"], analyst: ["analyst", "analyste"], viewer: ["viewer", "lecteur"], reviewer: ["reviewer", "réviseur"],
};
const ASSETS: Record<string, string> = {
  Multifamily: "Multilogement", "Mixed-use": "Usage mixte", Industrial: "Industriel", Office: "Bureaux", Retail: "Commerce de détail",
  Hospitality: "Hôtellerie", "Self storage": "Entreposage libre-service", Other: "Autre",
};

const BUDGET_LINES: Record<string, string> = { land: "terrain", hard: "coûts directs", soft: "coûts indirects", contingency: "provision pour imprévus", other: "autres coûts", developmentCharges: "redevances de développement", landTransferTax: "droits de mutation immobilière", gstHstNet: "TPS/TVH nette des remboursements" };
const LOANS: Record<string, string> = { "senior loan": "prêt principal", "mezzanine loan": "prêt mezzanine", "refinance loan": "prêt de refinancement" };
const frNum = (x: string) => Number(x).toLocaleString("fr-CA");
const frPct = (x: string) => `${frNum(x)}\u00a0%`;

// ---- Messages produced by the engine and the API, in French ----------------------------------
const SALE_SHARES: Record<string, string> = {
  "presold share": "La part prévendue",
  deposit: "Le dépôt",
  "sales commission": "La commission de vente",
  "lender's presale threshold": "Le seuil de prévente du prêteur",
};

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
  [/^A deal that is kept and refinanced needs its refinance: the month, the amount or loan-to-value, the rate and the amortization\.$/, "Un projet conservé et refinancé exige son refinancement : le mois, le montant ou le ratio prêt-valeur, le taux et l'amortissement."],
  [/^The deal is kept and refinanced, not sold\.$/, "Le projet est conservé et refinancé, non vendu."],
  [/^No debt is in force after the refinance\.$/, "Aucune dette n'est en vigueur après le refinancement."],
  [/^Cash left in the deal is 0 or below, so all of the equity has come back and there is nothing left to earn on\.$/, "L'encaisse restée dans le projet est de 0 ou moins : tous les fonds propres sont revenus et il ne reste rien sur quoi gagner un rendement."],
  [/^Only (\d+) months remain before the end of the hold, so this uses them, scaled to a year\.$/, (m) => `Il ne reste que ${m[1]} mois avant la fin de la détention ; ils sont utilisés ici, ramenés à une année.`],
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
  // A document source, as a run lists it: "name, page 1, line 2" or "name, Sheet!C5", with a note when it was given in m².
  [/^(.+), converted from square metres \("(.+)"\)$/, (m) => `${translateMessage(m[1])}, converti de mètres carrés (« ${m[2]} »)`],
  [/^(.+?), (page \d+, line \d+|line \d+|paragraph \d+)$/, (m) => `${m[1]}, ${translateMessage(m[2])}`],
  [/^A document states this in (.+); this deal is in (CAD|USD|AUD)\. Enter the amount in \2\.$/, (m) => `Un document l'indique en ${m[1]!.replace(" and ", " et ")} ; ce dossier est en ${m[2]}. Saisissez le montant en ${m[2]}.`],
  [/^A document states this in (.+); this deal does not state its currency\. Enter the amount\.$/, (m) => `Un document l'indique en ${m[1]!.replace(" and ", " et ")} ; ce dossier n'indique pas sa devise. Saisissez le montant.`],
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
  [/^The figure's unit \((.+)\) does not fit (.+)$/, (m) => `L'unité du chiffre (${m[1]}) ne convient pas à ${m[2]}`],
  [/^The figure is outside what (.+) can hold$/, (m) => `Le chiffre est hors des limites de ${m[1]}`],
  [/^The figure is no longer in the document$/, "Le chiffre n'est plus dans le document"],
  [/^This field needs an item name$/, "Ce champ demande un nom d'élément"],
  [/^A reviewer is added by requesting Agir review$/, "Un réviseur est ajouté en demandant une révision Agir"],
  [/^This person is an Agir reviewer; their access is changed by requesting Agir review$/, "Cette personne fait partie de la révision Agir ; son accès se modifie en demandant une révision Agir"],
  [/^Review access lasts between 1 and 90 days$/, "L'accès de révision dure de 1 à 90 jours"],
  [/^This person is already a member of the workspace; a reviewer must be someone outside it$/, "Cette personne est déjà membre de l'espace ; un réviseur doit venir de l'extérieur de l'espace"],
  [/^Sign in to continue\.$/, "Connectez-vous pour continuer."],
  [/^That email and password do not match\.$/, "Ce courriel et ce mot de passe ne correspondent pas."],
  [/^An account with that email already exists\.$/, "Un compte existe déjà avec ce courriel."],
  [/^Too many attempts\. Wait a minute\.$/, "Trop de tentatives. Patientez une minute."],
  [/^Some fields are missing or not valid\.$/, "Des champs manquent ou ne sont pas valides."],
  [/^Underwriting is blocked until review is clear\.$/, "L'analyse est bloquée jusqu'à la fin de l'examen."],
  [/^No document states this value any more; to keep it, say why \(at least 10 characters\)$/, "Aucun document n'indique plus cette valeur ; pour la conserver, dites pourquoi (au moins 10 caractères)"],
  [/^Someone changed this value while you were looking at it\. Reload and try again\.$/, "Quelqu'un a modifié cette valeur pendant que vous la consultiez. Rechargez la page et réessayez."],
  [/^A conflict can only be resolved to one of the documented values\./, "Un conflit ne peut être résolu que par l'une des valeurs documentées. Utilisez « Saisir une autre valeur » pour déroger."],
  [/^Say why you are entering a different value \(at least 10 characters\)$/, "Expliquez pourquoi vous saisissez une autre valeur (au moins 10 caractères)"],
  [/^Only a workspace in solo review can use its own value as stated; here a second person must confirm it$/, "Seul un espace de travail en examen individuel peut utiliser sa propre valeur comme déclarée ; ici, une seconde personne doit la confirmer"],
  [/^Only a value waiting for a second approver can be used as stated$/, "Seule une valeur qui attend un second approbateur peut être utilisée comme déclarée"],
  [/^Only the person who entered this value can use it as stated$/, "Seule la personne qui a saisi cette valeur peut l'utiliser comme déclarée"],
  [/^A second approver must be a different person from the one who entered the value$/, "Le second approbateur doit être une autre personne que celle qui a saisi la valeur"],
  [/^Say where this value comes from \(at least 10 characters\)$/, "Précisez d'où vient cette valeur (au moins 10 caractères)"],
  [/^This field already has a value; review it instead$/, "Ce champ a déjà une valeur ; examinez-la plutôt"],
  [/^This deal already has (.+); change its values instead\.$/, (m) => `Ce projet a déjà ${m[1]} ; modifiez plutôt ses valeurs.`],
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
  // The engine's own checks (validateInput and readiness). Numbers in the sentence are written the French way.
  [/^budget (land|hard|soft|contingency|other|developmentCharges|landTransferTax|gstHstNet) must be a number of at least 0$/, (m) => `Le poste « ${BUDGET_LINES[m[1]!]} » du budget doit être un nombre positif ou nul`],
  [/^property tax must be a number of at least 0$/, "La taxe foncière doit être un nombre positif ou nul"],
  [/^refinance insurance premium must be a number from (\d+) to (\d+)$/, (m) => `La prime d'assurance du refinancement doit se situer entre ${frPct(m[1]!)} et ${frPct(m[2]!)}`],
  [/^a credit in other costs cannot take the total budget to 0 or below$/, "Un crédit dans les autres coûts ne peut pas ramener le budget total à 0 ou moins"],
  [/^a credit in other costs cannot be more than hard costs, soft costs and contingency together$/, "Un crédit dans les autres coûts ne peut pas dépasser l'ensemble des coûts directs, des coûts indirects et de la provision pour imprévus"],
  [/^A credit: reduces total cost$/, "Un crédit\u00a0: il réduit le coût total"],
  [/^A negative figure that does not say it is a credit$/, "Chiffre négatif dont rien n'indique qu'il s'agit d'un crédit"],
  [/^at least one revenue component is required$/, "Au moins une composante de revenus est requise"],
  [/^revenue component "(.+)" needs a unit count above 0$/, (m) => `La composante de revenus « ${m[1]} » exige un nombre d'unités supérieur à 0`],
  [/^revenue component "(.+)" needs a monthly rent$/, (m) => `La composante de revenus « ${m[1]} » exige un loyer mensuel`],
  [/^revenue component "(.+)" needs a rentable area above 0$/, (m) => `La composante de revenus « ${m[1]} » exige une superficie locative supérieure à 0`],
  [/^revenue component "(.+)" needs a rent per SF$/, (m) => `La composante de revenus « ${m[1]} » exige un loyer par pi²`],
  [/^revenue component "(.+)" occupancy must be between (\d+) and (\d+)$/, (m) => `L'occupation de la composante de revenus « ${m[1]} » doit se situer entre ${frPct(m[2]!)} et ${frPct(m[3]!)}`],
  [/^construction months must be a whole number from (\d+) to (\d+)$/, (m) => `La durée de construction doit être un nombre entier de mois, de ${frNum(m[1]!)} à ${frNum(m[2]!)}`],
  [/^lease-up months must be a whole number from (\d+) to (\d+)$/, (m) => `La période de location doit être un nombre entier de mois, de ${frNum(m[1]!)} à ${frNum(m[2]!)}`],
  [/^hold years must be a whole number from (\d+) to (\d+)$/, (m) => `La période de détention doit être un nombre entier d'années, de ${frNum(m[1]!)} à ${frNum(m[2]!)}`],
  [/^stabilized occupancy must be between (\d+) and (\d+)$/, (m) => `L'occupation stabilisée doit se situer entre ${frPct(m[1]!)} et ${frPct(m[2]!)}`],
  [/^an expense ratio or fixed operating costs are required$/, "Un ratio des charges d'exploitation ou des charges d'exploitation fixes est requis"],
  [/^give either an expense ratio or fixed operating costs, not both$/, "Indiquez soit un ratio des charges d'exploitation, soit des charges d'exploitation fixes, pas les deux"],
  [/^exit cap rate must be above (\d+)$/, (m) => `Le taux de capitalisation à la sortie doit être supérieur à ${frPct(m[1]!)}`],
  [/^selling costs must be from (\d+) to under (\d+) percent$/, (m) => `Les frais de vente doivent être de ${frPct(m[1]!)} à moins de ${frPct(m[2]!)}`],
  [/^(senior loan|mezzanine loan|refinance loan) amount must be at least (\d+)$/, (m) => `Le montant du ${LOANS[m[1]!]} doit être d'au moins ${frNum(m[2]!)}`],
  [/^(senior loan|mezzanine loan|refinance loan) rate must be at least (\d+)$/, (m) => `Le taux du ${LOANS[m[1]!]} doit être d'au moins ${frPct(m[2]!)}`],
  [/^(senior loan|mezzanine loan|refinance loan) amortization must be (\d+) to (\d+) years$/, (m) => `L'amortissement du ${LOANS[m[1]!]} doit être de ${frNum(m[2]!)} à ${frNum(m[3]!)} ans`],
  [/^(senior loan|mezzanine loan|refinance loan) interest-only months must be (\d+) to (\d+)$/, (m) => `La période d'intérêts seulement du ${LOANS[m[1]!]} doit être de ${frNum(m[2]!)} à ${frNum(m[3]!)} mois`],
  [/^refinance month must fall from stabilization \(month (-?\d+)\) to before the sale \(month (-?\d+)\)$/, (m) => `Le mois du refinancement doit se situer entre la stabilisation (mois ${frNum(m[1]!)}) et la vente (mois ${frNum(m[2]!)}), avant celle-ci`],
  [/^give the refinance either a loan amount or a loan-to-value, not both or neither$/, "Pour le refinancement, indiquez soit un montant de prêt, soit un ratio prêt-valeur\u00a0: l'un des deux, pas les deux ni aucun"],
  [/^LP share must be above (\d+) and below (\d+)$/, (m) => `La part des commanditaires doit être supérieure à ${frPct(m[1]!)} et inférieure à ${frPct(m[2]!)}`],
  [/^preferred return must be at least (\d+)$/, (m) => `Le rendement privilégié doit être d'au moins ${frPct(m[1]!)}`],
  [/^GP promote must be from (\d+) to (\d+)$/, (m) => `L'intéressement du commandité doit être de ${frPct(m[1]!)} à ${frPct(m[2]!)}`],
  // Selling the units (card 77).
  [/^unit sale details apply only to a deal that sells its units$/, "Les données de vente des unités ne s'appliquent qu'à un projet qui vend ses unités"],
  [/^a deal that sells its units cannot state rents$/, "Un projet qui vend ses unités ne peut pas déclarer de loyers"],
  [/^a deal that sells its units cannot have a refinance$/, "Un projet qui vend ses unités ne peut pas comporter de refinancement"],
  [/^a deal that sells its units cannot have a lease-up period$/, "Un projet qui vend ses unités ne peut pas comporter de période de location"],
  [/^a deal that sells its units needs its sale details$/, "Un projet qui vend ses unités exige ses données de vente"],
  [/^a deal that sells its units needs at least one unit type$/, "Un projet qui vend ses unités exige au moins un type d'unité"],
  [/^unit type "(.+)" needs a whole unit count above 0$/, (m) => `Le type d'unité « ${m[1]} » exige un nombre entier d'unités supérieur à 0`],
  [/^unit type "(.+)" needs a sale price of at least 0$/, (m) => `Le type d'unité « ${m[1]} » exige un prix de vente d'au moins 0\u00a0$`],
  [/^(presold share|deposit|sales commission|lender's presale threshold) must be between (\d+) and (\d+)$/, (m) => `${SALE_SHARES[m[1]!]} doit se situer entre ${frPct(m[2]!)} et ${frPct(m[3]!)}`],
  [/^sales pace must be above 0 units per month$/, "Le rythme de vente doit être supérieur à 0 unité par mois"],
  [/^months from completion to first closing must be a whole number of at least 0$/, "Le délai entre l'achèvement et la première conclusion de vente doit être un nombre entier de mois, d'au moins 0"],
  [/^carry per unsold unit must be at least 0$/, "Les frais de possession par unité non vendue doivent être d'au moins 0\u00a0$"],
  // Sale readiness (card 78).
  [/^Sell the units and keep and refinance cannot both be chosen$/, "La vente des logements et leur conservation avec refinancement ne peuvent pas être choisies ensemble"],
  [/^Unit types \(at least one, with a count and a sale price\)$/, "Types de logements (au moins un, avec un nombre et un prix de vente)"],
  [/^Sale price per unit \((.+)\)$/, (m) => `Prix de vente par logement (${m[1]})`],
  [/^(.+) does not apply when the units are sold$/, (m) => `${FR_FIELDS[FIELDS.find((f) => f.label === m[1])?.key ?? ""] ?? m[1]} ne s'applique pas lorsque les logements sont vendus`],
  [/^(.+) applies only when the units are sold$/, (m) => `${FR_FIELDS[FIELDS.find((f) => f.label === m[1])?.key ?? ""] ?? m[1]} ne s'applique que lorsque les logements sont vendus`],
  // The reasons readiness gives for a value that cannot be used.
  [/^not a number$/, "n'est pas un nombre"],
  [/^below the minimum of (-?[\d.]+)$/, (m) => `inférieur au minimum de ${frNum(m[1]!)}`],
  [/^above the maximum of (-?[\d.]+)$/, (m) => `supérieur au maximum de ${frNum(m[1]!)}`],
  [/^must be a whole number$/, "doit être un nombre entier"],
  [/^(.+) and (.+) are one item written two ways$/, (m) => `${m[1]} et ${m[2]} désignent un même élément écrit de deux façons`],
  [/^Reject the values of one, or enter them under one name\.$/, "rejetez les valeurs de l'un, ou saisissez-les sous un seul nom."],
  [/^(.+) (cannot be below|cannot be above|must be a whole number|needs a number)(.*)$/, (m) => `${m[1]} : ${m[2] === "cannot be below" ? "ne peut pas être inférieur à" : m[2] === "cannot be above" ? "ne peut pas être supérieur à" : m[2] === "must be a whole number" ? "doit être un nombre entier" : "exige un nombre"}${m[3]}`],
];

/** CMHC's names for the debt coverage ratio (DCR; in French CCD, as in its multi-unit reference guide), in place of the lenders' DSCR / RCSD. Whole words only. */
const plainTerm = (lang: Lang, text: string) => (lang === "fr" ? text.replace(/\bRCSD\b/g, "CCD") : text.replace(/\bDSCR\b/g, "DCR"));

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
      // Whole dollars stay whole; a rent with cents shows both digits ($3,095.20, not $3,095.2).
      case "$/unit/mo": case "$/mo": { const n = Number.isInteger(v) ? n0 : n2; return fr ? `${n.format(v)} $/mois` : `$${n.format(v)}/mo`; }
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

export function build(lang: Lang, setLang: (l: Lang) => void) {
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
      return plainTerm(lang, item ? `${base} (${item})` : base);
    },
    ask: (key: string) => (ASK[key]?.[idx] ?? [FIELD_BY_KEY.get(key)?.label ?? key]).map((x) => plainTerm(lang, x ?? "")),
    help: (key: string, en: string | null) => { const h = lang === "fr" ? FR_HELP[key] ?? en : en; return h && plainTerm(lang, h); },
    absent: (key: string) => { const en = FIELD_BY_KEY.get(key)?.absentMeans ?? ""; return plainTerm(lang, lang === "fr" ? FR_ABSENT[key] ?? en : en); },
    /** One readiness item as a line of the review card: the field's name (with the item), then the reason when there is one; the engine's own sentence when it is about no single field. */
    item: (i: ReadinessItem) => {
      const sentence = (x: string) => { const o = msg(x); return o.charAt(0).toUpperCase() + o.slice(1); };
      // In French the field's name stands for the label, unless the label is a sentence of its own (two names for one item).
      if (i.detail) return lang === "fr" ? `${translateMessage(i.label) !== i.label ? sentence(i.label) : L.field(i.fieldKey, i.itemKey)}\u00a0: ${msg(i.detail)}` : `${i.label}: ${i.detail}`;
      if (lang === "en") return i.label.charAt(0).toUpperCase() + i.label.slice(1);
      if (i.fieldKey === "unit_count" && !i.itemKey) return t("review.revenueProgram");
      return translateMessage(i.label) !== i.label || i.fieldKey === "input" ? sentence(i.label) : L.field(i.fieldKey, i.itemKey);
    },
    group: (g: string) => GROUPS[g]?.[idx] ?? g,
    metric: (key: string) => plainTerm(lang, (lang === "fr" ? FR_METRICS[key]?.[0] : METRIC_BY_KEY.get(key)?.label) ?? key),
    formula: (key: string) => (lang === "fr" ? FR_METRICS[key]?.[1] : METRIC_BY_KEY.get(key)?.formula) ?? "",
    stress: (key: string, en: string) => plainTerm(lang, STRESS[key]?.[idx] ?? en),
    gate: (key: string, en: string) => plainTerm(lang, GATES[key]?.[idx] ?? en),
    driver: (key: string) => DRIVERS_L[key]?.[idx] ?? key,
    /** One breakeven row as text: the sentence for a value, the reason for any other state. Every figure is the engine's. */
    breakeven: (r: BreakevenText, gate: { key: string; label: string; threshold: number; unit: string }) => {
      const unit = BE_UNIT[r.driver] ?? "%";
      const mag = (v: number) => f.delta(Math.abs(v), unit).slice(1);
      if (r.state === "out_of_range") return lang === "fr" ? `Pas dans les limites de ${f.delta(r.limit, unit)}` : `Not within ${f.delta(r.limit, unit)}`;
      if (r.state === "no_effect") return lang === "fr" ? `Dans les limites de ${f.delta(r.limit, unit)}, cette hypothèse ne change pas le chiffre de ce critère.` : `Within ${f.delta(r.limit, unit)}, this input does not change this gate's figure.`;
      if (r.state === "not_monotonic") return lang === "fr" ? "Le critère ne varie pas de façon régulière avec cette hypothèse\u00a0; utilisez la grille." : "The gate does not move steadily with this input; use the grid.";
      const fr = lang === "fr";
      const to = r.to.map((e) => {
        const v = f.value(e.to, e.unit);
        switch (e.key) {
          case "rent": return `${e.item}: ${v}`;
          case "cost": return fr ? `coût total ${v}` : `total cost ${v}`;
          case "exit_cap": return fr ? `taux de sortie ${v}` : `exit cap ${v}`;
          case "occupancy": return fr ? `occupation ${v}` : `occupancy ${v}`;
          case "senior_rate": return fr ? `prêt senior ${v}` : `senior ${v}`;
          case "mezzanine_rate": return `mezzanine ${v}`;
          default: return fr ? `refinancement ${v}` : `refinance ${v}`;
        }
      }).join("; ");
      const m = mag(r.shock!);
      const text = (fr
        ? { rentPct: `Les loyers devraient être ${m} plus élevés`, costPct: `Les coûts de développement devraient être ${m} plus bas`, exitCapBps: `Le taux de sortie devrait être ${m} plus bas`, rateBps: `Les taux d'intérêt devraient être ${m} plus bas`, occupancyPts: `L'occupation devrait être ${m} plus élevée` }
        : { rentPct: `Rents would need to be ${m} higher`, costPct: `Development costs would need to be ${m} lower`, exitCapBps: `The exit cap rate would need to be ${m} lower`, rateBps: `Interest rates would need to be ${m} lower`, occupancyPts: `Occupancy would need to be ${m} higher` }
      )[r.driver as "rentPct"];
      const g = L.gate(gate.key, gate.label).replace(/^\p{Lu}(?=\p{Ll})/u, (c) => c.toLowerCase());
      const thr = f.value(gate.threshold, gate.unit);
      return fr
        ? `${text}${to ? ` (${to})` : ""} pour que ${g} atteigne ${thr}. Les autres hypothèses sont fixes\u00a0; les changements combinés interagissent.`
        : `${text}${to ? ` (${to})` : ""} for ${g} to reach ${thr}. Other inputs are held; moves together interact.`;
    },
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
  const msg = (text: string | null | undefined) => plainTerm(lang, lang === "fr" ? translateMessage(text) : text ?? "");
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

/** The verdict's headline and explanation, in the chosen language, from the stored gates. A solo owner sets their own conditions. */
export function verdictText(i: I18n, v: VerdictLike, checks: CheckLike[], solo = false): { headline: string; explanation: string } {
  const r = verdictTextRaw(i, v, checks, solo);
  return { headline: plainTerm(i.lang, r.headline), explanation: plainTerm(i.lang, r.explanation) };
}

/** "five" and "four" are spelled out as the engine does, so a v1 verdict's other counts stay digits. */
const countWord = (n: number, total: number) => (n === 5 ? "five" : n === 4 && total === 4 ? "four" : String(n));
const frCount = (n: number, total: number) => (n === 5 ? "cinq" : n === 4 && total === 4 ? "quatre" : String(n));

function verdictTextRaw(i: I18n, v: VerdictLike, checks: CheckLike[], solo: boolean): { headline: string; explanation: string } {
  if (i.lang === "en") {
    const failed = v.gates.filter((g) => g.status === "failed");
    const measured = v.gates.filter((g) => g.status !== "not_applicable").length;
    const ne = v.gates.filter((g) => g.status === "not_evaluated");
    const errors = checks.filter((c) => c.severity === "error");
    switch (v.code) {
      case "APPROVE":
        return { headline: measured === v.gates.length ? `All ${countWord(measured, v.gates.length)} gates pass.` : `All ${measured} applicable gates pass.`, explanation: "The deal clears every return hurdle and holds its coverage under combined stress." };
      case "APPROVE_WITH_CONDITIONS":
        return { headline: `${failed.length} ${s(failed.length, "gate fails", "gates fail")}. ${solo ? "You set the conditions." : "The committee sets conditions."}`, explanation: `Failing: ${failed.map((g) => g.label).join("; ")}.` };
      case "NOT_EVALUATED":
        return { headline: "Not evaluated. Nothing was decided.", explanation: `These gates could not be measured: ${ne.map((g) => g.label).join("; ")}.` };
      default:
        if (v.hardFailReasons.length) {
          return {
            headline: errors.length === 1 ? "The deal fails a check that no gate can offset." : `The deal fails ${errors.length} checks that no gate can offset.`,
            explanation: v.hardFailReasons.join(" "),
          };
        }
        return { headline: failed.length === measured ? `All ${countWord(measured, v.gates.length)} gates fail.` : `${failed.length} of ${measured} gates fail.`, explanation: `Failing: ${failed.map((g) => g.label).join("; ")}.` };
    }
  }
  const failed = v.gates.filter((g) => g.status === "failed").map((g) => i.L.gate(g.key, g.label));
  const measured = v.gates.filter((g) => g.status !== "not_applicable").length;
  const ne = v.gates.filter((g) => g.status === "not_evaluated").map((g) => i.L.gate(g.key, g.label));
  const errors = checks.filter((c) => c.severity === "error");
  switch (v.code) {
    case "APPROVE":
      return {
        headline: measured === v.gates.length ? `Les ${frCount(measured, v.gates.length)} seuils sont respectés.` : `Les ${measured} seuils applicables sont respectés.`,
        explanation: "Le projet franchit tous les seuils de rendement et maintient sa couverture sous le stress combiné.",
      };
    case "APPROVE_WITH_CONDITIONS":
      return {
        headline: `${failed.length} ${s(failed.length, "seuil n'est pas respecté", "seuils ne sont pas respectés")}. ${solo ? "Vous fixez les conditions." : "Le comité fixe des conditions."}`,
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
        headline: failed.length === measured ? `Aucun des ${frCount(measured, v.gates.length)} seuils n'est respecté.` : `${failed.length} seuils sur ${measured} ne sont pas respectés.`,
        explanation: `Non respectés : ${failed.join(" ; ")}.`,
      };
  }
}

/** A check's message in the chosen language, from its key and figures. */
export function checkText(i: I18n, c: CheckLike, ltcCeiling = 85): string {
  return plainTerm(i.lang, checkTextRaw(i, c, ltcCeiling));
}

function checkTextRaw(i: I18n, c: CheckLike, ltcCeiling: number): string {
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
      if (c.message.startsWith("The stated value")) return `La valeur déclarée, ${$(a)}, ne couvre pas les ${$(e)} de dette en cours. Les fonds propres n'ont aucune valeur à la fin de la détention.`;
      return `Le produit net de la vente, ${$(a)}, ne rembourse pas les ${$(e)} de dette en cours. Les fonds propres sont anéantis à la sortie.`;
    case "mezz_interest_accrued":
      return `Des intérêts de ${$(a)} sur la mezzanine s'ajoutent à son solde une fois son engagement de ${$(e)} utilisé ; le solde de la mezzanine à la stabilisation est de ${$((e ?? NaN) + (a ?? NaN))}.`;
    case "presale_threshold_unmet":
      return `Le prêt de construction exige ${pct(e)} de logements prévendus ; ${pct(a)} sont déclarés.`;
    case "for_sale_debt_unpaid":
      return `Scénario de base : une dette de ${$(a)} reste à rembourser après la dernière conclusion de vente.`;
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
  review: { approved: number; needsReview: number; conflicting: number; awaitingSecond: number; missing: number; impossible: number; status: string };
  run: { verdict: string; fresh: boolean } | null;
  decision: { decision: string } | null;
  reports: number;
};

/** A deal's status line and next action, from its evidence, in the chosen language. */
export function dealStatus(i: I18n, o: OverviewLike, solo = false): { tone: "pass" | "review" | "stop" | "neutral"; text: string; next: string; blockedParts: string[] } {
  const { t, L } = i;
  const r = o.review;
  // Documents are optional evidence: a deal with values and no documents is read from its values, as the server's overview does.
  if (o.documents.total === 0 && r.approved + r.needsReview + r.conflicting + r.awaitingSecond === 0) return { tone: "neutral", text: t("status.noDocs"), next: t("next.upload"), blockedParts: [] };
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
    return { tone: v === "APPROVE" ? "pass" : v === "REJECT" ? "stop" : "review", text: t("status.verdict", { v: L.verdict(v) }), next: t(solo ? "next.decideSolo" : "next.decide"), blockedParts: [] };
  }
  return {
    tone: o.decision.decision.startsWith("approve") ? "pass" : "stop",
    text: t("status.decided", { d: L.decision(o.decision.decision).toLowerCase() }),
    next: o.reports > 0 ? t("next.share") : t("next.memo"),
    blockedParts: [],
  };
}
