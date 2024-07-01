/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * 
 * Author: John Bieling
 * Version: 1.1 (28.06.2024)
 */

const path = require("path");
const fs = require("fs-extra");
const https = require("https");
const yargs = require("yargs");
const jsonUtils = require("comment-json");
const extract = require("extract-zip");

const HELP_SCREEN = `

Usage:

    node get_thunderbird_schema_files.js <options>
    
Options:
   --compat                   - Path to the thunderbird webextension compatibility
                                data module (will become obsolete once released as
                                an npm module).
   --manifest_version=number  - The requested manifest version of the schema
                                files. Allowed values are "2" and "3".
   --output=path              - Path of a folder to store the processed schema
                                files. All existing files in that folder will be
                                deleted.
   --release=name             - The name of the Thunderbird release to get the
                                schema files for. The files will be downloaded
                                from hg.mozilla.org. Examples: "central", "beta"
                                or "esr115". Either --release or --source has to
                                be specified.
   --source=path              - Path to a local checkout of a mozilla repository
                                with a matching /comm directory. The mozilla-*
                                folder created in the temporary download folder
                                after using the --release option will work also.
                                Either --release or --source has to be specified.
`;

// URL placeholder and their correct value. These are replaced if found inside
// an <a> tag in descriptions.
const URL_REPLACEMENTS = {
  "url-binary-string":
    "https://developer.mozilla.org/en-US/docs/Web/API/DOMString/Binary",
  "url-canvas-element":
    "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/canvas",
  "url-css-color-string":
    "https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_colors/Color_values",
  "url-commands-shortcuts":
    "https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/commands#shortcut_values",
  "url-content-scripts":
    "https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts",
  "url-content-script-click-capture":
    "https://bugzilla.mozilla.org/show_bug.cgi?id=1618828#c3",
  "url-content-type":
    "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Type",
  "url-contextmenu-event":
    "https://developer.mozilla.org/en-US/docs/Web/API/Element/contextmenu_event",
  "url-contextualIdentity":
    "https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/contextualIdentities",
  "url-cookieStore":
    "https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/contextualIdentities/ContextualIdentity#cookiestoreid",
  "url-date-time-format":
    "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat/DateTimeFormat",
  "url-dom-file": "https://developer.mozilla.org/docs/Web/API/File",
  "url-dom-file-array-buffer":
    "https://developer.mozilla.org/en-US/docs/Web/API/Blob/arrayBuffer",
  "url-dom-file-text":
    "https://developer.mozilla.org/en-US/docs/Web/API/Blob/text",
  "url-help-cannot-encrypt":
    "https://support.mozilla.org/en-US/kb/thunderbird-help-cannot-encrypt",
  "url-choosing-icon-size":
    "https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_action#choosing_icon_sizes",
  "url-image-data":
    "https://developer.mozilla.org/en-US/docs/Web/API/ImageData",
  "url-input-encoding":
    "https://developer.mozilla.org/en-US/docs/Web/API/Encoding_API/Encodings",
  "url-legacy-properties":
    "https://searchfox.org/comm-central/rev/8a1ae67088acf237dab2fd704db18589e7bf119e/mailnews/addrbook/modules/VCardUtils.jsm#295-334",
  "url-match-patterns":
    "https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Match_patterns",
  "url-mdn-browser-styles":
    "https://developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions/user_interface/Browser_styles",
  "url-mdn-icon-size":
    "https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_action#choosing_icon_sizes",
  "url-runtime-last-error":
    "https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/lastError",
  "url-runtime-on-connect":
    "https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/onConnect",
  "url-runtime-on-message":
    "https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/onMessage",
  "url-theme-experiment":
    "https://github.com/thunderbird/sample-extensions/tree/master/manifest_v2/theme_experiment",
  "url-ui-elements":
    "https://developer.thunderbird.net/add-ons/mailextensions/supported-ui-elements#menu-items",
  "url-user-input-restrictions":
    "https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/User_actions",
};

const TEMP_DIR = "temp";
const API_DOC_BASE_URL = "https://webextension-api.thunderbird.net/en";

let schemas = [];
let api_doc_branch = "stable";

const args = yargs.argv;
let bcd;
if ((!args.source && !args.release) || !args.compat || !args.output || !args.manifest_version) {
  console.log(HELP_SCREEN);
} else {
  bcd = require(args.compat);
  main();
}

// -----------------------------------------------------------------------------

async function main() {
  // Some additional sanity checks.
  if (!["2", "3"].includes(`${args.manifest_version}`)) {
    console.log(`Unsupported Manifest Version: <${args.manifest_version}>`);
    return;
  }

  // Download schema files, if requested.
  if (args.release) {
    args.source = await downloadSchemaFilesIntoTempFolder(args.release);
  } else {
    // Set the release based on the provided folder name.
    args.release = path.basename(args.source).split("-")[1];
  }

  // Determine api_doc_branch based on requested release.
  if (["central", "beta"].includes(args.release)) {
    api_doc_branch = "latest";
  } else if (args.release.startsWith("esr")) {
    api_doc_branch = args.release.substring(3);
  } else {
    console.log(
      `Unknown release: ${args.release}. Falling back to "stable" for API_DOC_URL generation`
    );
    api_doc_branch = "stable";
  }
  if (args.manifest_version == "3") {
    api_doc_branch += "-mv3";
  }

  // Setup output directory.
  if (!fs.existsSync(args.output)) {
    fs.mkdirSync(args.output, { recursive: true });
  }
  for (const file of await fs.readdir(args.output)) {
    await fs.unlink(path.join(args.output, file));
  }

  // Parse the toolkit schema files.
  readSchemaFiles(
    "firefox",
    getJsonFiles(
      path.join(args.source, "toolkit", "components", "extensions", "schemas")
    )
  );

  // Parse the browser schema files.
  readSchemaFiles(
    "firefox",
    getJsonFiles(
      path.join(args.source, "browser", "components", "extensions", "schemas")
    )
  );

  // Parse Thunderbird's own schema files.
  readSchemaFiles(
    "thunderbird",
    getJsonFiles(
      path.join(
        args.source,
        "comm",
        "mail",
        "components",
        "extensions",
        "schemas"
      )
    )
  );

  // An API should list `version_added: false` to indicate no support. A missing
  // __compat entry indicates default behavior = support.
  const BCD_SUPPORTED_APIS = Object.keys(bcd.webextensions.api).filter(
    e => bcd.webextensions.api[e]?.__compat?.support?.thunderbird?.version_added !== false
  );
  const BCD_SUPPORTED_MANIFESTS = Object.keys(bcd.webextensions.manifest).filter(
    e => bcd.webextensions.manifest[e]?.__compat?.support?.thunderbird?.version_added !== false
  );
  const THUNDERBIRD_APIS = schemas
    .filter(e => e.owner == "thunderbird")
    .map(e => e.json.map(n => n.namespace)).flat()
    .filter(e => e != "manifest");

  // Filter out unsupported.
  schemas = schemas.flatMap(schema => {
    // Keep Thunderbird APIs.
    if (schema.owner == "thunderbird") {
      return [schema];
    }
    // Remove re-implemented
    if (schema.json.map(e => e.namespace).some(e => THUNDERBIRD_APIS.includes(e))) {
      return [];
    }
    // Remove unsupported.
    if (!schema.json.map(e => e.namespace).some(e => BCD_SUPPORTED_APIS.includes(e))) {
      // Before removing this file, check if it extends the global manifest with
      // a supported WebExtensionManifest entry.
      let manifestTypes = schema.json
        .filter(e => e.namespace == "manifest")
        .map(e => e.types).flat()
      if(manifestTypes
        .filter(e => e.$extend == "WebExtensionManifest")
        .map(e => Object.keys(e.properties)).flat()
        .some(e => BCD_SUPPORTED_MANIFESTS.includes(e))
      ) {
        return [schema];
      }
      // Also check, if it defines either the global WebExtensionManifest or
      // the global ManifestBase entry.
      if(manifestTypes
        .some(e => ["ManifestBase", "WebExtensionManifest"].includes(e.id))
      ) {
        return [schema];
      }
      return [];
    }
    return [schema];
  });

  // Process $import.
  for (const schema of schemas) {
    schema.json = processImports(schema.json);
  }

  // Process schemas.
  for (const schema of schemas) {
    schema.json = processSchema(
      schema.json,
      null,
      args.manifest_version,
      schema.owner
    );
  }

  // Write files.
  for (const schema of schemas) {
    const output_file_name = schema.file.name;
    await writePrettyJSONFile(
      path.join(args.output, output_file_name),
      sortKeys(schema.json)
    );
  }
}

// -----------------------------------------------------------------------------

async function downloadSchemaFilesIntoTempFolder(release) {
  if (!release) {
    throw new Error(
      "Missing release parameter in downloadSchemaFilesIntoTempFolder()"
    );
  }

  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR);
  }

  const folders = new Set();
  const directories = ["mail", "browser", "toolkit"];
  for (let i = 0; i < directories.length; i++) {
    const folderName = directories[i];
    const fileName = path.join(TEMP_DIR, `${release}-${folderName}.zip`);
    console.log(
      ` [${i + 1}/${
        directories.length
      }] Downloading ${release}-${folderName}.zip from ${release} ...`
    );
    try {
      await download(getHgZipPath(release, folderName), fileName);
    } catch (ex) {
      throw new Error("Download failed, try again later");
    }
    console.log(
      ` [${i + 1}/${
        directories.length
      }] Unpacking ${release}-${folderName}.zip ...`
    );
    await extract(path.resolve(fileName), {
      dir: path.resolve(TEMP_DIR),
      onEntry: entry => folders.add(entry.fileName.split("/")[0]),
    });
    await fs.unlink(fileName);
  }

  // Renaming folders and moving /comm inside of /mozilla.
  let mozillaFolder;
  for (const folder of folders) {
    const parts = folder.split("-").map(e => e.toLowerCase());
    if (parts[0] == "mozilla") {
      mozillaFolder = folder;
    }
    if (parts[0] == "comm") {
      fs.renameSync(path.join(TEMP_DIR, folder), path.join(TEMP_DIR, "comm"));
    }
  }

  // Check we have the folders we need.
  if (
    !fs.existsSync(path.join(TEMP_DIR, mozillaFolder)) ||
    !fs.existsSync(path.join(TEMP_DIR, "comm"))
  ) {
    throw new Error("Download of schema files did not succeed!");
  }

  await fs.move(
    path.join(TEMP_DIR, "comm"),
    path.join(TEMP_DIR, mozillaFolder, "comm"),
    { overwrite: true }
  );
  return path.join(TEMP_DIR, mozillaFolder);
}

// Recursive merge, to is modified.
function mergeObjects(to, from) {
  for (const n in from) {
    if (typeof to[n] != "object") {
      to[n] = from[n];
    } else if (typeof from[n] == "object") {
      to[n] = mergeObjects(to[n], from[n]);
    }
  }
  return to;
}

function getJsonFiles(folderPath) {
  return fs
    .readdirSync(folderPath, { withFileTypes: true })
    .filter(
      item =>
        !item.isDirectory() && path.extname(item.name).toLowerCase() === ".json"
    );
}

function readSchemaFiles(owner, files) {
  for (const file of files) {
    const json = jsonUtils.parse(
      fs.readFileSync(path.join(file.path, file.name), "utf-8")
    );
    schemas.push({
      file,
      json,
      owner,
    });
  }
}

/**
 * Get URL to download schema files from hg.mozilla.org.
 *
 * @param {string} release - The release, for example central, beta, esr115, ...
 * @param {string} directory - The directory, one of browser, toolkit or mail.
 *
 * @returns {string} URL pointing to zip download of schema files on hg.mozilla.org.
 */
function getHgZipPath(release, directory) {
  const root = release.endsWith("central") ? "" : "releases/";
  const branch = directory == "mail" ? "comm-" : "mozilla-";
  return `https://hg.mozilla.org/${root}${branch}${release}/archive/tip.zip/${directory}/components/extensions/schemas`;
}

/**
 * Replace $import statements by the actual referenced element/namespace.
 *
 * @param {any} value - The value to process. Usually a schema JSON, but the
 *   function recursively calls itself on nested elements.
 *
 * @returns {any} The processed value.
 */
function processImports(value) {
  if (typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(processImports);
  }

  if (value.hasOwnProperty("$import")) {
    // Assume imports are unique, ignore prepended namespace (lazy me).
    const id = value.$import.split(".").pop();
    delete value.$import;

    // We skip ManifestBase for now.
    if (id != "ManifestBase") {
      let imported = getNestedIdOrNamespace(schemas, id);
      if (imported) {
        // Do not import top level manifest limits.
        imported = JSON.parse(JSON.stringify(imported));
        delete imported.min_manifest_version;
        delete imported.max_manifest_version;
        // Do not import namespace name and id.
        delete imported.namespace;
        delete imported.id;
        return mergeObjects(value, imported);
      }
      console.log(`Missing requested import: ${id}`);
    }
  }

  // Default.
  return Object.keys(value).reduce((o, key) => {
    o[key] = processImports(value[key]);
    return o;
  }, {});
}

/**
 * Helper function to find an element or namespace in the provided (nested) obj.
 *
 * @param {any} value - The value to process. Usually the global schema data, but
 *   the function recursively calls itself on nested elements.
 * @param {string} searchString - The id or namespace name to look for.
 *
 * @returns {any} The processed value.
 */
function getNestedIdOrNamespace(value, searchString) {
  if (typeof value !== "object") {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const element of value) {
      const rv = getNestedIdOrNamespace(element, searchString);
      if (rv !== undefined) {
        return rv;
      }
    }
    return undefined;
  }

  // An object
  if (value.namespace == searchString) {
    return value;
  }
  if (value.id == searchString) {
    return value;
  }
  for (const element of Object.values(value)) {
    const rv = getNestedIdOrNamespace(element, searchString);
    if (rv !== undefined) {
      return rv;
    }
  }
  return undefined;
}

/**
 * Sort JSON by keys for better diff-ability, filter by manifest version, merge
 * enums, remove single leftover choices.
 *
 * @param {any} value - The value to process. Usually a schema JSON, but the
 *   function recursively calls itself on nested elements.
 * @param {string} requested_manifest_version - The manifest version which should
 *   used. Invalid elements are removed.
 *
 * @returns {any} The processed value.
 */
function processSchema(
  value,
  name,
  requested_manifest_version,
  owner,
  fullPath = ""
) {
  if (typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .filter(
        v =>
          (!v.min_manifest_version ||
            v.min_manifest_version <= requested_manifest_version) &&
          (!v.max_manifest_version ||
            v.max_manifest_version >= requested_manifest_version)
      )
      .map(e => processSchema(e, e.name, requested_manifest_version, owner, fullPath));
  }

  // Looks like value is an object. Find out where we are to be able to retrieve
  // compat data.
  if (value.namespace) {
    // Reset.
    fullPath = value.namespace;
  }

  if (name && typeof name !== "object") {
    fullPath = `${fullPath}.${name}`;
    const parts = fullPath.split(".");
    // Check if we are at the event/type/function level.
    if (
      parts.length == 3 &&
      ["types", "functions", "events", "properties"].includes(parts[1])
    ) {
      const [namespace, , name] = parts;
      addCompatData(value, owner, {
        namespaceName: namespace,
        entryName: name,
      })
    }

    // Check if we are at the parameters level.
    if (
      parts.length == 5 &&
      ["types", "functions", "events"].includes(parts[1]) &&
      "parameters" == parts[3]
    ) {
      const [namespace, , name, , parameter] = parts;
      addCompatData(value, owner, {
        namespaceName: namespace,
        entryName: name,
        paramName: parameter
      })
    }
  } else {
    // Top-level properties are not an array, but an object with the property
    // names as keys. 
    const parts = fullPath.split(".");
    if (parts.length == 2 && parts[1] == "properties") {
      for (let key of Object.keys(value)) {
       value[key] = processSchema(value[key], key, requested_manifest_version, owner, fullPath)
      }
      return value;
    }
  }

  return Object.keys(value)
    .reduce((o, key) => {
      let v = value[key];
      const v_orig_length = v.length;
      if (
        (!v.min_manifest_version ||
          v.min_manifest_version <= requested_manifest_version) &&
        (!v.max_manifest_version ||
          v.max_manifest_version >= requested_manifest_version)
      ) {
        v = processSchema(
          value[key],
          value[key].name,
          requested_manifest_version,
          owner,
          `${fullPath}.${key}`
        );
        switch (key) {
          case "min_manifest_version":
          case "max_manifest_version":
            // Do not include manifest limits in clean per-single-manifest schema
            // files.
            break;
          case "choices":
            // Merge enums if a choice is all but enums.
            if (v_orig_length != v.length && v.every(e => !!e.enum)) {
              // Merge into first entry.
              v[0].enum = v
                .reduce((enums, entry) => {
                  enums.push(...entry.enum);
                  return enums;
                }, [])
                .sort();
              v = [v[0]];
            }

            // If the manifest_version filter reduced the choice entries and we
            // are left with only one, remove the choice.
            if (v_orig_length != v.length && v.length == 1) {
              Object.assign(o, v[0]);
            } else {
              o[key] = v;
            }
            break;
          case "description":
          case "deprecated":
            if (typeof v === "string") {
              // Newer schema files use the Firefox notation directly, but older
              // ones may still use the deprecated reStructuredText notations.
              // Fix any remaining deprecated notation.
              v = v.replace(/``(.+?)``/g, "<val>$1</val>");
              v = v.replace(/:doc:`(.*?)`/g, "$(doc:$1)");
              v = v.replace(/:ref:`(.*?)`/g, "$(ref:$1)");
              v = v.replace(
                /:permission:`(.*?)`/g,
                "<permission>$1</permission>"
              );

              // Replace URLs.
              v = v.replace(/`(.*?) <(.*?)>`__/g, "<a href='$2'>$1</a>");
              v = v.replace(/href='url-.*?'/g, match => {
                const placeholder = match.slice(6, -1);
                if (URL_REPLACEMENTS[placeholder]) {
                  return `href='${URL_REPLACEMENTS[placeholder]}'`;
                }
                console.log(`Unknown url placeholder: ${placeholder}`);
                return match;
              });

              // Replace single back ticks.
              v = v.replace(/`(.+?)`/g, "<val>$1</val>");
            }
          default:
            o[key] = v;
        }
      }

      return o;
    }, {});
}

function sortKeys(x) {
  if (typeof x !== "object" || !x) {
    return x;
  }
  if (Array.isArray(x)) {
    return x.map(sortKeys);
  }
  return Object.keys(x)
    .sort()
    .reduce((o, k) => ({ ...o, [k]: sortKeys(x[k]) }), {});
}

/**
 * Helper function to produce pretty JSON files.
 *
 * @param {string} path - The path to write the JSON to.
 * @param {obj} json - The obj to write into the file.
 */
async function writePrettyJSONFile(path, json) {
  try {
    return await fs.outputFile(path, JSON.stringify(json, null, 4));
  } catch (err) {
    console.error("Error in writePrettyJSONFile()", path, err);
    throw err;
  }
}

/**
 * Helper function to download a file.
 *
 * @param {string} url - The URL to download.
 * @param {string} path - The path to write the downloaded file to.
 */
function download(url, path) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(path);
    https
      .get(url, response => {
        response.pipe(file);
        file.on("finish", () => {
          file.close(() => {
            resolve();
          });
        });
      })
      .on("error", err => {
        reject(err);
      });
  });
}

function addCompatData(value, owner, pathData) {
  const {namespaceName, entryName, paramName, propertyName} = pathData;
  let addApiDoc = true;
  let entry = 
    bcd.webextensions.api[namespaceName] &&
    bcd.webextensions.api[namespaceName][entryName]

  if (entry && paramName) {
    entry = entry[paramName];
    addApiDoc = false;
  }
  if (entry && propertyName) {
    entry = entry[propertyName];
  }
  if (!entry) return;

  let compatData = entry.__compat;
  if (!compatData) {
    return
  }

  if (compatData?.mdn_url) {
    value.mdn_url = compatData.mdn_url;
  }
  if (compatData?.support?.thunderbird) {
    value.support = compatData.support.thunderbird;
  }
  if (addApiDoc && owner == "thunderbird") {
    // Generate Thunderbird API_DOC_URL.
    const anchorParts = [entryName];
    if (value.parameters) {
      anchorParts.push(...value.parameters.map(e => e.name).filter(e => e != "callback"))
    }
    const anchor = anchorParts.join("-").toLowerCase();
    value.api_documentation_url = `${API_DOC_BASE_URL}/${api_doc_branch}/${namespaceName}.html#${anchor}`;
  }
}