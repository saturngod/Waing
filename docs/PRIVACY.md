# Privacy statement

Waing is local-first. Project paths, prompts, agent output, permission decisions, workflow history, and provider session identifiers are stored in the app's local SQLite database. Waing does not operate an application telemetry or crash-reporting service in the MVP.

Provider CLIs and SDKs may communicate with their own vendors according to the provider account and configuration selected by the user. Waing does not proxy those requests and does not alter provider privacy terms.

Secrets managed directly by Waing are encrypted with Electron `safeStorage`; plaintext credentials are not written to normal configuration. Diagnostic exports are user-initiated and contain app/platform metadata plus redacted provider health and capability information. They exclude source files, prompts, model responses, environment variables, cookies, authorization headers, and credentials.

Removing the application does not necessarily remove its user-data directory. Users can remove the Waing application data using the operating system's normal application-data controls.
