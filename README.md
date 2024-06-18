Overview
========

This script pulls Thunderbird's WebExtension schema files from `hg.mozilla.org`
or from a local checkout of the Mozilla Mercurial code repository.

Schema files of APIs not supported by Thunderbird are left out. Additionally, the
schema files are processed as follows:
 
 * `$import` keys are replaced by the referenced entities
 * entries not supported by the requested Manifest version are removed
 * URL placeholders in `<a>` tags in description are replaced
 * the Firefox schema files are enriched by browser-compat-data
 * the Thunderbird schema files are enriched by the api_documentation_url property


Install needed packages
=======================

```
npm install comment-json fs-extra yargs path extract-zip @mdn/browser-compat-data
```

Usage
=====

```
   node get_thunderbird_schema_files.js <options>
```
  
Options
=======

```
    --release=name             - The name of the Thunderbird release to get the
                                 schema files for. The files will be downloaded
                                 from hg.mozilla.org. Examples: "central", "beta"
                                 or "esr115". Either --release or --input has to
                                 be specified.
    --input=path               - Path to a local checkout of a mozilla repository
                                 with a matching /comm directory. The mozilla-*
                                 folder created in the temporary download folder
                                 after using the --release option will work also.
                                 Either --release or --input has to be specified.
    --output=path              - Path of a folder to store the processed schema
                                 files. All existing files in that folder will be
                                 deleted.
    --manifest_version=number  - The requested manifest version of the schema
                                 files. Allowed values are "2" and "3".
```
