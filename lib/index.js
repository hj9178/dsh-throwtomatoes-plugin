/**
 * dsh-throwtomatoes-plugin — node half.
 *
 * Pure UI plugin: every feature lives in the browser half
 * (`exports["./client"]`, zipped into the web bundle through the package.json
 * `dsh.client` declaration). The empty `apply` exists so the plugin owns a
 * slot in the host cordis.yml / Loader and can be enabled or disabled from the
 * profile like any other plugin.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
function apply() {}

export { apply };
