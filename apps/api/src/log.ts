// The log and alert hook (card B) live with the worker since card S8, so the standalone worker alerts by the same code.
export { alerter, alertWorkerEvent, log, type LogFields, type Logger } from "@agir/worker/log";
