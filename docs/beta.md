# Beta feedback

Before reporting an issue, reproduce it once on the newest beta and note the provider, provider version, selected model, mode, effort, workflow preset, and whether the run was resumed.

In Waing, open Settings and choose **Export redacted diagnostics**. Review the JSON before sharing it; the export deliberately excludes source, prompts, responses, environment variables, and secrets. Include the file with:

- expected and actual behavior;
- exact reproduction steps;
- operating system and Waing version;
- whether denying a permission or restarting changed the result;
- screenshots with private project information removed.

Security vulnerabilities and accidentally exposed credentials should not be posted in a public issue. Revoke exposed provider credentials first and use the project's private security contact when one is published.
