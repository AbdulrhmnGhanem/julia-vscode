import * as toml from '@iarna/toml'
import * as vscode from 'vscode'
import * as rpc from 'vscode-jsonrpc'
import { registerCommand } from '../utils'
import { g_connection as g_repl_connection, startREPL } from './repl'

export function activate(context: vscode.ExtensionContext) {
    VersionLens.register(context)
}

type uuid = string
type TomlDependency = { [packageName: string]: uuid }
type ProjectTomlSection = 'deps' | 'extras' | 'compat' | 'targets'
type ProjectTomlKey = 'name' | 'version' | 'uuid'
type ProjectToml = {
    authors?: string[];
    compat?: TomlDependency;
    deps?: TomlDependency;
    extras?: TomlDependency;
    name: string;
    targets?: object;
    uuid?: uuid;
    version?: string;
}

namespace VersionLens {
    const projectTomlSelector = { pattern: '**/Project.toml', language: 'toml' }
    const requestTypeLens = new rpc.RequestType<{ name: string, uuid: string }, {
        latest_version: string, url: string, registry: string
    }, void>('lens/pkgVersions')
    const updateDependencyCommand = 'language-julia.updateDependency'
    const VersionLensQueryRegistriesCommand = 'language-julia.versionsLensQueryRegistries'
    let g_juliaVersionLensRegistriesReady = false
    let g_juliaVersionLensRegistriesLoading = false

    /**
     * Register codelens, {@link updateDependencyCommand}, and hoverProvider for Project.toml versions.
     */
    export function register(context: vscode.ExtensionContext) {
        registerGeneralLenses(context)
        registerSectionsFieldsLenses(context)

        context.subscriptions.push(vscode.languages.registerCodeLensProvider(
            projectTomlSelector,
            { provideCodeLenses },
        ))

        context.subscriptions.push(registerCommand(updateDependencyCommand, updateDependency))
        context.subscriptions.push(registerCommand(VersionLensQueryRegistriesCommand, queryRegistries))
    }

    function registerSectionsFieldsLenses(context:vscode.ExtensionContext) {
        context.subscriptions.push(vscode.languages.registerHoverProvider(
            projectTomlSelector,
            { provideHover: provideDepsFieldsHover }
        ))
        context.subscriptions.push(vscode.languages.registerHoverProvider(
            projectTomlSelector,
            { provideHover: provideCompatFieldsHover }
        ))
        context.subscriptions.push(vscode.languages.registerHoverProvider(
            projectTomlSelector,
            { provideHover: provideExtrasFieldsHover }
        ))
    }

    function registerGeneralLenses(context: vscode.ExtensionContext) {
        context.subscriptions.push(vscode.languages.registerHoverProvider(
            projectTomlSelector,
            { provideHover: provideFieldsAndHeadersHover }
        ))
    }

    /**
     * See {@link vscode.CodeLensProvider}.
     */
    function provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken) {
        const { deps } = getProjectTomlFields(document)
        const ranges = getSectionFieldsRanges(document, 'deps', deps)
        return ranges.map(([dependency, range]) =>
            new vscode.CodeLens(range, { title: 'update', command: updateDependencyCommand, arguments: [dependency]})
        )
    }

    /**
     * See {@link vscode.HoverProvider}.
     */
    function provideFieldsAndHeadersHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken) {
        const { name, uuid, version } = getProjectTomlFields(document)

        if (uuid) {
            const uuidRange = getFieldRange(document, 'uuid', uuid)
            const hover = fieldHover('uuid', uuidRange, position)
            if (hover) { return hover }
        }

        if (name) {
            const nameRange = getFieldRange(document, 'name', name)
            const hover = fieldHover('name', nameRange, position)
            if (hover) { return hover }
        }

        if (version) {
            const versionRange = getFieldRange(document, 'version', version)
            const hover = fieldHover('version', versionRange, position)
            if (hover) { return hover }
        }

        const sectionsHeadersRanges = getSectionsHeadersRanges(document)
        for (const [sectionName, range] of sectionsHeadersRanges) {
            if (range.contains(position)) {
                return new vscode.Hover(
                    Tooltips.sectionsHeaders[sectionName],
                    range
                )
            }
        }
    }

    function provideDepsFieldsHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken) {
        const { deps } = getProjectTomlFields(document)

        if (deps) {
            const depsRanges = getSectionFieldsRanges(document, 'deps', deps)
            return sectionHover('deps', depsRanges, position)
        }
    }


    function provideExtrasFieldsHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken) {
        const {  extras } = getProjectTomlFields(document)

        if (extras) {
            const extrasRanges = getSectionFieldsRanges(document, 'extras', extras)
            return sectionHover('extras', extrasRanges, position)
        }
    }

    function provideCompatFieldsHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken) {
        const { compat } = getProjectTomlFields(document)

        if (compat) {
            const compatRanges = getSectionFieldsRanges(document, 'compat', compat)
            return sectionHover('compat', compatRanges, position)
        }
    }

    async function updateDependency(dependency: TomlDependency) {
        if (g_repl_connection === undefined) {
            // If there's no active repl, start one.
            await startREPL(false)
        }

        const depName = Object.keys(dependency)[0]
        const metadata = await g_repl_connection.sendRequest(requestTypeLens, {name: depName, uuid: dependency[depName]})
        console.log({ metadata })
    }

    async function queryRegistries() {
        if (g_repl_connection === undefined) {
            g_juliaVersionLensRegistriesLoading = true
            await startREPL(false)
            g_juliaVersionLensRegistriesLoading = false
        }

        g_juliaVersionLensRegistriesReady = true
    }

    function getProjectTomlFields(document: vscode.TextDocument) {
        const documentText = document.getText()
        return toml.parse(documentText) as ProjectToml
    }

    function getSectionsHeadersRanges(document: vscode.TextDocument) {
        const sectionsNames: Array<ProjectTomlSection> = ['deps', 'compat', 'extras', 'targets']
        const documentText = document.getText()

        return sectionsNames
            .map(sectionName => {
                const sectionRegExp = RegExp(`\\[${sectionName}\\]`)
                const matchedSection = documentText.match(sectionRegExp)
                const sectionLength = matchedSection?.length ? matchedSection[0].length : 0

                if (sectionLength !== 0) {
                    return [
                        sectionName,
                        new vscode.Range(
                            document.positionAt(matchedSection.index),
                            document.positionAt(matchedSection.index + sectionLength)
                        )
                    ] as [ProjectTomlSection, vscode.Range]
                }
            })
            .filter(range => range !== undefined)
    }

    function getSectionFieldsRanges(document: vscode.TextDocument, section: ProjectTomlSection, fields: TomlDependency,) {
        /*
        * ┌──────►Match the section header, e.g., [deps].
        * │ ┌────►Match a newline or any character, zero or more times until──┐
        * │ │ ┌───────────────────────────────────────────────────────────────┘
        * │ │ │
        * │ │ └┐►Match a newline followed by the beginning of another section, i.e., `[`, or EOF.
        * │ │  └─────────────────────────────────────────────────┐
        * │ └────────────────────────┐                           │
        * │        ┌────────────────┬┴─────────────────────────┬─┴───────────────────────────────────────────┐
        * └────────┤\\[${section}\\]│ (${NEWLINE_DELIMITER}|.)*│${NEWLINE_DELIMITER}(\\[|${NEwLINE_DELIMITER}│
        *          └────────────────┴──────────────────────────┴─────────────────────────────────────────────┘
        */
        const NEWLINE_DELIMITER = '(\r\n|\r|\n)'
        const sectionFieldsRegExp = RegExp(
            `\\[${section}\\](${NEWLINE_DELIMITER}|.)*${NEWLINE_DELIMITER}(\\[|${NEWLINE_DELIMITER})`
        )

        const documentText = document.getText()
        const matchedSectionField = documentText.match(sectionFieldsRegExp)
        const sectionFieldStart = matchedSectionField?.index
        const sectionFieldText = matchedSectionField[0]

        const depsNames = Object.keys(fields)
        return depsNames.map(depName => {
            const fieldRegexp = RegExp(`${depName}[ ]*=[ ]*("|')${fields[depName]}("|')`)
            const fieldPosition = sectionFieldText.match(fieldRegexp)
            const fieldLength = fieldPosition[0]?.length

            return [
                { [depName]: fields[depName] },
                new vscode.Range(
                    document.positionAt(fieldPosition?.index + sectionFieldStart),
                    document.positionAt(fieldPosition?.index  + fieldLength + sectionFieldStart)
                )
            ] as [TomlDependency, vscode.Range]
        })
    }

    function getFieldRange(document: vscode.TextDocument, key: ProjectTomlKey, value: string) {
        const documentText = document.getText()
        const fieldRegExp = RegExp(`${key}[ ]*=[ ]*("|')${value}("|')`)
        const matchedField = documentText.match(fieldRegExp)
        const fieldLength = matchedField?.length ? matchedField[0]?.length : 0

        if (fieldLength !== 0) {
            return new vscode.Range(
                document.positionAt(matchedField.index),
                document.positionAt(matchedField.index + fieldLength)
            )
        } else {
            // Return empty range
            return new vscode.Range(document.positionAt(-1), document.positionAt(-1))
        }
    }

    function fieldHover(key: ProjectTomlKey, range: vscode.Range, position: vscode.Position) {
        if (range.contains(position)) {
            return new vscode.Hover(
                Tooltips[key],
                range
            )
        }
    }

    async function sectionHover(key: ProjectTomlSection, depsRanges: [TomlDependency, vscode.Range][], position: vscode.Position) {
        if (!(g_juliaVersionLensRegistriesLoading || g_juliaVersionLensRegistriesReady)) {
            for (const [_, range] of depsRanges) {
                if (range.contains(position)) {
                    return new vscode.Hover(Tooltips.queryRegistriesHint, range)
                }
            }
        }

        if (g_juliaVersionLensRegistriesLoading) {
            for (const [_, range] of depsRanges) {
                if (range.contains(position)) {
                    return new vscode.Hover('loading...', range)
                }
            }
        }

        if (g_juliaVersionLensRegistriesReady) {
            for (const [dependency, range] of depsRanges) {
                if (range.contains(position)) {
                    const depName = Object.keys(dependency)[0]
                    const { latest_version, url, registry } = await g_repl_connection.sendRequest(
                        requestTypeLens, { name: depName, uuid: dependency[depName] }
                    )

                    return new vscode.Hover(
                        Tooltips.DependencyHover(depName, latest_version, url, registry),
                        range
                    )
                }
            }
        }
    }
}

namespace Tooltips {
    export const name = new vscode.MarkdownString(dedent`
    The name of the package/project.
    The \`name\` can contain word characters \`[a-zA-Z0-9_]\`, but can not start with a number.
    For packages it is recommended to follow [the package naming guidelines](http://pkgdocs.julialang.org/v1/creating-packages/#Package-naming-guidelines).
    \nThe \`name\` field is mandatory for packages. See [Pkg docs](http://pkgdocs.julialang.org/v1/toml-files/#The-name-field).
    `)
    export const uuid = new vscode.MarkdownString(dedent`
    A string with a [universally unique identifier](https://en.wikipedia.org/wiki/Universally_unique_identifier) for the package/project.
    \nThe \`uuid\` field is mandatory for packages. See [Pkg docs](http://pkgdocs.julialang.org/v1/toml-files/#The-uuid-field).
    `)
    export const version = new vscode.MarkdownString(dedent`
    A string with the version number for the package/project.
    Julia uses [Semantic Versioning (SemVer)](https://semver.org/).
    See [Pkg docs](http://pkgdocs.julialang.org/v1/toml-files/#The-version-field).
    \n**Note that Pkg.jl deviates from the SemVer specification when it comes to versions pre-1.0.0.
    See the section on [pre-1.0 behavior](http://pkgdocs.julialang.org/v1/compatibility/#compat-pre-1.0) for more details.**
    `)
    export const sectionsHeaders = {
        deps: new vscode.MarkdownString(dedent`
        All dependencies of the package/project.
        Each dependency is listed as a name-uuid pair.
        Typically it is not needed to manually add entries to the \`[deps]\` section; this is instead handled by \`Pkg\` operations such as \`add\`.
        See [Pkg docs](http://pkgdocs.julialang.org/v1/toml-files/#The-[deps]-section).
        `),
        compat: new vscode.MarkdownString(dedent`
        Compatibility constraints for the dependencies listed under \`[deps]\`.
        See [Pkg docs](http://pkgdocs.julialang.org/v1/compatibility/#Compatibility).
        `),
        extras: new vscode.MarkdownString(dedent`
        Test-specific dependencies in Julia \`1.0\` and \`1.1\`.
        See [Pkg docs](http://pkgdocs.julialang.org/v1/creating-packages/#Test-specific-dependencies-in-Julia-1.0-and-1.1).
        `),
        targets: new vscode.MarkdownString(dedent`
        Test-specific dependencies in Julia \`1.0\` and \`1.1\`.
        See [Pkg docs](http://pkgdocs.julialang.org/v1/creating-packages/#Test-specific-dependencies-in-Julia-1.0-and-1.1).
        `)
    }
    export const queryRegistriesHint = new vscode.MarkdownString(
        'To get packages information, click on the `$(versions)` icon in the editor title bar.',
        true
    )

    /**
     * @constructor
     */
    export function DependencyHover(name: string, latestVersion: string, url: string, registry: string) {
        return new vscode.MarkdownString(dedent`
        - ${name} in the \`${registry}\` registry.
        - The latest version is \`${latestVersion}\`.
        - More on [the package Homepage](${url}).
        `)
    }

    function dedent(callSite, ...args) {
        function format(str) {
            let size = -1

            return str.replace(/\n(\s+)/g, (m, m1) => {

                if (size < 0)
                {size = m1.replace(/\t/g, '    ').length}

                return '\n' + m1.slice(Math.min(m1.length, size))
            })
        }

        if (typeof callSite === 'string') {
            return format(callSite)
        }

        if (typeof callSite === 'function') {
            return (...args) => format(callSite(...args))
        }

        const output = callSite
            .slice(0, args.length + 1)
            .map((text, i) => (i === 0 ? '' : args[i - 1]) + text)
            .join('')

        return format(output)
    }
}
