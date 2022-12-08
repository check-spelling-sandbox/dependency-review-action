import spdxSatisfies from 'spdx-satisfies'
import {Change, Changes} from './schemas.js'
import {isSPDXValid, octokitClient} from './utils.js'

/**
 * Loops through a list of changes, filtering and returning the
 * ones that don't conform to the licenses allow/deny lists.
 *
 * Keep in mind that we don't let users specify both an allow and a deny
 * list in their config files, so this code works under the assumption that
 * one of the two list parameters will be empty. If both lists are provided,
 * we will ignore the deny list.
 * @param {Change[]} changes The list of changes to filter.
 * @param { { allow?: string[], deny?: string[]}} licenses An object with `allow`/`deny` keys, each containing a list of licenses.
 * @returns {Promise<{Object.<string, Array.<Change>>}} A promise to a Record Object. The keys are strings, unlicensed, unresolved and forbidden. The values are a list of changes
 */
export async function getInvalidLicenseChanges(
  changes: Change[],
  licenses: {
    allow?: string[]
    deny?: string[]
  }
): Promise<Record<string, Changes>> {
  const {allow, deny} = licenses

  const groupedChanges = await groupChanges(changes)
  const licensedChanges: Changes = groupedChanges.licensed

  const invalidLicenseChanges: Record<string, Changes> = {
    unlicensed: groupedChanges.unlicensed,
    unresolved: [],
    forbidden: []
  }

  const validityCache = new Map<string, boolean>()

  for (const change of licensedChanges) {
    const license = change.license

    // should never happen since licensedChanges always have licenses but license is nullable in changes schema
    if (license === null) {
      continue
    }

    if (license === 'NOASSERTION') {
      invalidLicenseChanges.unlicensed.push(change)
    } else if (validityCache.get(license) === undefined) {
      try {
        if (allow !== undefined) {
          const found = allow.find(spdxExpression =>
            spdxSatisfies(license, spdxExpression)
          )
          validityCache.set(license, found !== undefined)
        } else if (deny !== undefined) {
          const found = deny.find(spdxExpression =>
            spdxSatisfies(license, spdxExpression)
          )
          validityCache.set(license, found === undefined)
        }
      } catch (err) {
        invalidLicenseChanges.unresolved.push(change)
      }
    }

    if (validityCache.get(license) === false) {
      invalidLicenseChanges.forbidden.push(change)
    }
  }

  return invalidLicenseChanges
}

const fetchGHLicense = async (
  owner: string,
  repo: string
): Promise<string | null> => {
  try {
    const response = await octokitClient().rest.licenses.getForRepo({
      owner,
      repo
    })
    return response.data.license?.spdx_id ?? null
  } catch (_) {
    return null
  }
}

const parseGitHubURL = (url: string): {owner: string; repo: string} | null => {
  try {
    const parsed = new URL(url)
    if (parsed.host !== 'github.com') {
      return null
    }
    const components = parsed.pathname.split('/')
    if (components.length < 3) {
      return null
    }
    return {owner: components[1], repo: components[2]}
  } catch (_) {
    return null
  }
}

const setGHLicenses = async (changes: Change[]): Promise<Change[]> => {
  const updatedChanges = changes.map(async change => {
    if (change.license !== null || change.source_repository_url === null) {
      return change
    }

    const githubUrl = parseGitHubURL(change.source_repository_url)

    if (githubUrl === null) {
      return change
    }

    return {
      ...change,
      license: await fetchGHLicense(githubUrl.owner, githubUrl.repo)
    }
  })

  return Promise.all(updatedChanges)
}
// Currently Dependency Graph licenses are truncated to 255 characters
// This possibly makes them invalid spdx ids
const truncatedDGLicense = (license: string): boolean =>
  license.length === 255 && !isSPDXValid(license)

async function groupChanges(
  changes: Changes
): Promise<Record<string, Changes>> {
  const result: Record<string, Changes> = {
    licensed: [],
    unlicensed: []
  }

  const ghChanges = []

  for (const change of changes) {
    if (change.change_type === 'removed') {
      continue
    }

    if (change.license === null) {
      if (change.source_repository_url !== null) {
        ghChanges.push(change)
      } else {
        result.unlicensed.push(change)
      }
    } else {
      if (
        truncatedDGLicense(change.license) &&
        change.source_repository_url !== null
      ) {
        ghChanges.push(change)
      } else {
        result.licensed.push(change)
      }
    }
  }

  if (ghChanges.length > 0) {
    const ghLicenses = await setGHLicenses(ghChanges)
    for (const change of ghLicenses) {
      if (change.license === null) {
        result.unlicensed.push(change)
      } else {
        result.licensed.push(change)
      }
    }
  }

  return result
}
