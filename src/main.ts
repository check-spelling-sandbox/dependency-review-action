import * as core from '@actions/core'
import * as dependencyGraph from './dependency-graph'
import * as github from '@actions/github'
import styles from 'ansi-styles'
import {RequestError} from '@octokit/request-error'
import {Change, Severity, Changes} from './schemas'
import {readConfig} from '../src/config'
import {
  filterChangesBySeverity,
  filterChangesByScopes,
  filterAllowedAdvisories
} from '../src/filter'
import {getInvalidLicenseChanges} from './licenses'
import * as summary from './summary'
import {getRefs} from './git-refs'

import {groupDependenciesByManifest} from './utils.js'
import {HTTPError} from 'got'

async function run(): Promise<void> {
  console.log(`run`)
  try {
    const config = await readConfig()
    console.log('config', config)
    const refs = getRefs(config, github.context)
    console.log('refs', refs)

    const changes = await dependencyGraph.compare({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      baseRef: refs.base,
      headRef: refs.head
    })
    console.log('changes', changes)

    const minSeverity = config.fail_on_severity
    console.log(`minSeverity: ${minSeverity}`)
    const scopedChanges = filterChangesByScopes(config.fail_on_scopes, changes)
    console.log(`scopedChanges: ${scopedChanges}`)
    const filteredChanges = filterAllowedAdvisories(
      config.allow_ghsas,
      scopedChanges
    )
    console.log(`filteredChanges: ${filteredChanges}`)

    const addedChanges = filterChangesBySeverity(
      minSeverity,
      filteredChanges
    ).filter(
      change =>
        change.change_type === 'added' &&
        change.vulnerabilities !== undefined &&
        change.vulnerabilities.length > 0
    )
    console.log(`addedChanges: ${addedChanges}`)

    const invalidLicenseChanges = await getInvalidLicenseChanges(
      filteredChanges,
      {
        allow: config.allow_licenses,
        deny: config.deny_licenses
      }
    )
    console.log(`invalidLicenseChanges: ${invalidLicenseChanges}`)

    summary.addSummaryToSummary(
      config.vulnerability_check ? addedChanges : null,
      config.license_check ? invalidLicenseChanges : null
    )

    if (config.vulnerability_check) {
      summary.addChangeVulnerabilitiesToSummary(addedChanges, minSeverity)
      printVulnerabilitiesBlock(addedChanges, minSeverity)
    }
    if (config.license_check) {
      summary.addLicensesToSummary(invalidLicenseChanges, config)
      printLicensesBlock(invalidLicenseChanges)
    }

    summary.addScannedDependencies(changes)
    printScannedDependencies(changes)
  } catch (error) {
    console.log(`error: ${error}`)
    if (error instanceof RequestError && error.status === 404) {
      core.setFailed(
        `Dependency review could not obtain dependency data for the specified owner, repository, or revision range.`
      )
    } else if (error instanceof RequestError && error.status === 403) {
      core.setFailed(
        `Dependency review is not supported on this repository. Please ensure that Dependency graph is enabled, see https://github.com/${github.context.repo.owner}/${github.context.repo.repo}/settings/security_analysis`
      )
    } else if (error instanceof HTTPError && error.response.statusCode === 404) {
      core.setFailed(
        `!! Dependency review could not obtain dependency data for the specified owner, repository, or revision range.`
      )
    } else if (error instanceof HTTPError && error.response.statusCode === 403) {
      core.setFailed(
        `!! Dependency review is not supported on this repository. Please ensure that Dependency graph is enabled, see https://github.com/${github.context.repo.owner}/${github.context.repo.repo}/settings/security_analysis`
      )
    } else {
      if (error instanceof Error) {
        core.setFailed(error.message)
      } else {
        core.setFailed('Unexpected fatal error')
      }
    }
  } finally {
    await core.summary.write()
  }
}

function printVulnerabilitiesBlock(
  addedChanges: Changes,
  minSeverity: Severity
): void {
  let failed = false
  core.group('Vulnerabilities', async () => {
    if (addedChanges.length > 0) {
      for (const change of addedChanges) {
        printChangeVulnerabilities(change)
      }
      failed = true
    }

    if (failed) {
      core.setFailed('Dependency review detected vulnerable packages.')
    } else {
      core.info(
        `Dependency review did not detect any vulnerable packages with severity level "${minSeverity}" or higher.`
      )
    }
  })
}

function printChangeVulnerabilities(change: Change): void {
  for (const vuln of change.vulnerabilities) {
    core.info(
      `${styles.bold.open}${change.manifest} » ${change.name}@${
        change.version
      }${styles.bold.close} – ${vuln.advisory_summary} ${renderSeverity(
        vuln.severity
      )}`
    )
    core.info(`  ↪ ${vuln.advisory_url}`)
  }
}

function printLicensesBlock(
  invalidLicenseChanges: Record<string, Changes>
): void {
  core.group('Licenses', async () => {
    if (invalidLicenseChanges.forbidden.length > 0) {
      core.info('\nThe following dependencies have incompatible licenses:')
      printLicensesError(invalidLicenseChanges.forbidden)
      core.setFailed('Dependency review detected incompatible licenses.')
    }
    if (invalidLicenseChanges.unresolved.length > 0) {
      core.warning(
        '\nThe validity of the licenses of the dependencies below could not be determined. Ensure that they are valid SPDX licenses:'
      )
      printLicensesError(invalidLicenseChanges.unresolved)
      core.setFailed(
        'Dependency review could not detect the validity of all licenses.'
      )
    }
    printNullLicenses(invalidLicenseChanges.unlicensed)
  })
}

function printLicensesError(changes: Changes): void {
  for (const change of changes) {
    core.info(
      `${styles.bold.open}${change.manifest} » ${change.name}@${change.version}${styles.bold.close} – License: ${styles.color.red.open}${change.license}${styles.color.red.close}`
    )
  }
}

function printNullLicenses(changes: Changes): void {
  if (changes.length === 0) {
    return
  }

  core.info('\nWe could not detect a license for the following dependencies:')
  for (const change of changes) {
    core.info(
      `${styles.bold.open}${change.manifest} » ${change.name}@${change.version}${styles.bold.close}`
    )
  }
}

function renderSeverity(
  severity: 'critical' | 'high' | 'moderate' | 'low'
): string {
  const color = (
    {
      critical: 'red',
      high: 'red',
      moderate: 'yellow',
      low: 'grey'
    } as const
  )[severity]
  return `${styles.color[color].open}(${severity} severity)${styles.color[color].close}`
}

function renderScannedDependency(change: Change): string {
  const changeType: string = change.change_type

  if (changeType !== 'added' && changeType !== 'removed') {
    throw new Error(`Unexpected change type: ${changeType}`)
  }

  const color = (
    {
      added: 'green',
      removed: 'red'
    } as const
  )[changeType]

  const icon = (
    {
      added: '+',
      removed: '-'
    } as const
  )[changeType]

  return `${styles.color[color].open}${icon} ${change.name}@${change.version}${styles.color[color].close}`
}

function printScannedDependencies(changes: Changes): void {
  core.group('Dependency Changes', async () => {
    const dependencies = groupDependenciesByManifest(changes)

    for (const manifestName of dependencies.keys()) {
      const manifestChanges = dependencies.get(manifestName) || []
      core.info(`File: ${styles.bold.open}${manifestName}${styles.bold.close}`)
      for (const change of manifestChanges) {
        core.info(`${renderScannedDependency(change)}`)
      }
    }
  })
}

run()
