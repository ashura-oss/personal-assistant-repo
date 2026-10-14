import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, '..');
const dtoFile = path.join(projectDirectory, 'src/cloud/workspaceDto.ts');
const outputFile = path.join(projectDirectory, 'src/cloud/workspaceSnapshotSchema.generated.ts');
const checkOnly = process.argv.includes('--check');

function fail(message) {
  throw new Error(`workspace snapshot schema generation failed: ${message}`);
}

const configPath = path.join(projectDirectory, 'tsconfig.json');
const configRead = ts.readConfigFile(configPath, ts.sys.readFile);
if (configRead.error) fail(ts.flattenDiagnosticMessageText(configRead.error.messageText, '\n'));
const config = ts.parseJsonConfigFileContent(configRead.config, ts.sys, projectDirectory, {
  noEmit: true,
  skipLibCheck: true,
}, configPath);
if (config.errors.length) fail(config.errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('\n'));

const program = ts.createProgram({ rootNames: [dtoFile], options: config.options });
const dtoDependencies = new Set(program.getSourceFiles().map((file) => path.resolve(file.fileName)));
const relevantErrors = ts.getPreEmitDiagnostics(program).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error && diagnostic.file && dtoDependencies.has(path.resolve(diagnostic.file.fileName)));
if (relevantErrors.length) fail(relevantErrors.map((diagnostic) => `${path.relative(projectDirectory, diagnostic.file.fileName)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`).join('\n'));
const checker = program.getTypeChecker();
const sourceFile = program.getSourceFile(dtoFile);
if (!sourceFile?.symbol) fail('workspaceDto module could not be loaded');
const dtoSymbol = checker.getExportsOfModule(sourceFile.symbol).find((symbol) => symbol.name === 'WorkspaceSnapshotDTO');
if (!dtoSymbol) fail('WorkspaceSnapshotDTO export was not found');
const rootType = checker.getDeclaredTypeOfSymbol(dtoSymbol);

const references = new Map();
const definitions = new Map();
const pending = [];
let nextReference = 0;
let reachableTypes = 0;

function referenceFor(type) {
  let reference = references.get(type);
  if (!reference) {
    reference = `R${String(++nextReference).padStart(4, '0')}`;
    references.set(type, reference);
    pending.push({ type, reference });
  }
  return reference;
}

function stripUndefined(type) {
  if (!(type.flags & ts.TypeFlags.Union)) return type;
  const members = type.types.filter((member) => !(member.flags & ts.TypeFlags.Undefined));
  if (members.length === type.types.length) return type;
  if (members.length === 0) return undefined;
  return checker.getUnionType(members, ts.UnionReduction.None);
}

function hasBroadIndexKey(type) {
  return Boolean(type.flags & (ts.TypeFlags.String | ts.TypeFlags.Number | ts.TypeFlags.Any | ts.TypeFlags.Unknown));
}
function hasUndefined(type) {
  return Boolean(type.flags & ts.TypeFlags.Undefined) || Boolean(type.flags & ts.TypeFlags.Union && type.types.some((member) => hasUndefined(member)));
}
function compareCodeUnits(left, right) { return left < right ? -1 : left > right ? 1 : 0; }

function namedObjectType(type) {
  // Use encounter-ordered references for anonymous mapped/utility types too.
  // DeepReadonly and Omit intentionally resolve many exported DTO nodes into
  // anonymous compiler types; structural refs keep recursive graphs finite.
  return Boolean(type.flags & ts.TypeFlags.Object);
}

function serializeLiteral(type) {
  if (type.flags & ts.TypeFlags.StringLiteral) return { kind: 'literal', value: type.value };
  if (type.flags & ts.TypeFlags.NumberLiteral) return { kind: 'literal', value: type.value };
  if (type.flags & ts.TypeFlags.BooleanLiteral) return { kind: 'literal', value: type.intrinsicName === 'true' };
  if (type.flags & ts.TypeFlags.Null) return { kind: 'literal', value: null };
  fail(`unsupported literal type ${checker.typeToString(type)}`);
}

function schemaFor(type, propertyName = 'root', expandReference = false) {
  reachableTypes += 1;
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) fail(`${propertyName} resolves to ${checker.typeToString(type)}`);
  if (type.flags & ts.TypeFlags.Never) return { kind: 'never' };
  if (type.flags & ts.TypeFlags.Undefined) fail(`${propertyName} requires undefined`);
  if (type.flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BooleanLiteral | ts.TypeFlags.Null)) return serializeLiteral(type);
  if (type.flags & ts.TypeFlags.String) return { kind: 'string' };
  if (type.flags & ts.TypeFlags.Number) return { kind: 'number' };
  if (type.flags & ts.TypeFlags.Boolean) return { kind: 'boolean' };
  if (type.flags & ts.TypeFlags.BigIntLike) fail(`${propertyName} has a bigint value`);
  if (type.flags & ts.TypeFlags.ESSymbolLike) fail(`${propertyName} has a symbol value`);

  if (type.flags & ts.TypeFlags.Union) {
    const alternatives = [...type.types].sort((left, right) => {
      const leftKey = checker.typeToString(left, undefined, ts.TypeFormatFlags.NoTruncation);
      const rightKey = checker.typeToString(right, undefined, ts.TypeFormatFlags.NoTruncation);
      return compareCodeUnits(leftKey, rightKey);
    });
    return { kind: 'union', alternatives: alternatives.map((member) => schemaFor(member, propertyName)) };
  }

  if (type.flags & ts.TypeFlags.Intersection) {
    const parts = [...type.types];
    const unionIndex = parts.findIndex((part) => part.flags & ts.TypeFlags.Union);
    if (unionIndex >= 0) {
      if (typeof checker.getIntersectionType !== 'function') fail(`${propertyName} needs intersection distribution support`);
      const unionPart = parts.splice(unionIndex, 1)[0];
      const alternatives = unionPart.types.map((variant) => checker.getIntersectionType([...parts, variant]));
      return { kind: 'union', alternatives: alternatives.map((variant) => schemaFor(variant, propertyName)) };
    }
    if (typeof checker.getIntersectionType !== 'function') fail(`${propertyName} has an unsupported intersection type`);
    const merged = checker.getIntersectionType(parts);
    if (merged === type || merged.flags & ts.TypeFlags.Intersection && merged.types.length === parts.length && merged.types.every((part, index) => part === parts[index])) {
      fail(`${propertyName} has an unsupported unresolved intersection`);
    }
    return schemaFor(merged, propertyName);
  }

  if (type.flags & ts.TypeFlags.Object) {
    if (checker.getSignaturesOfType(type, ts.SignatureKind.Call).length || checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length) {
      fail(`${propertyName} is callable`);
    }

    if (checker.isTupleType(type)) {
      fail(`${propertyName} is a tuple; tuple schema generation is unsupported`);
    }

    if (checker.isArrayType(type)) {
      const element = checker.getTypeArguments(type)[0];
      if (!element) fail(`${propertyName} has an unresolved array element type`);
      return { kind: 'array', element: schemaFor(element, `${propertyName}[]`) };
    }

    if (!expandReference && namedObjectType(type)) return { kind: 'ref', name: referenceFor(type) };
    return objectSchema(type, propertyName);
  }

  fail(`${propertyName} has an unresolved or unsupported type ${checker.typeToString(type)}`);
}

function objectSchema(type, pathLabel) {
  const stringIndex = checker.getIndexInfoOfType(type, ts.IndexKind.String);
  const numberIndex = checker.getIndexInfoOfType(type, ts.IndexKind.Number);
  if (stringIndex && hasBroadIndexKey(stringIndex.keyType)) {
    if (checker.getPropertiesOfType(type).length > 0) fail(`${pathLabel} mixes a string dictionary with declared properties`);
    return { kind: 'dictionary', value: schemaFor(stringIndex.type, `${pathLabel}{string}`) };
  }
  if (numberIndex && hasBroadIndexKey(numberIndex.keyType)) {
    fail(`${pathLabel} is a numeric dictionary; numeric index schemas are unsupported`);
  }

  const properties = {};
  const required = [];
  const symbols = checker.getPropertiesOfType(type).sort((left, right) => compareCodeUnits(left.getName(), right.getName()));
  for (const symbol of symbols) {
    const name = symbol.getName();
    if (name.startsWith('__@')) fail(`${pathLabel}.${name} is a symbol key`);
    const optional = Boolean(symbol.flags & ts.SymbolFlags.Optional);
    let propertyType = checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration ?? symbol.declarations?.[0] ?? sourceFile);
    if (optional) propertyType = propertyType.flags & ts.TypeFlags.Undefined ? undefined : stripUndefined(propertyType);
    else if (hasUndefined(propertyType)) fail(`${pathLabel}.${name} requires undefined`);
    properties[name] = propertyType === undefined ? { kind: 'never' } : schemaFor(propertyType, `${pathLabel}.${name}`);
    if (!optional) required.push(name);
  }
  if (!symbols.length && !stringIndex && !numberIndex) fail(`${pathLabel} is an empty object type`);
  return { kind: 'object', properties, required };
}

const root = schemaFor(rootType, 'WorkspaceSnapshotDTO');
for (let cursor = 0; cursor < pending.length; cursor += 1) {
  const { type, reference } = pending[cursor];
  if (definitions.has(reference)) continue;
  definitions.set(reference, schemaFor(type, checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation), true));
}

const orderedDefinitions = Object.fromEntries([...definitions.entries()].sort(([left], [right]) => compareCodeUnits(left, right)));
const generated = `/* Generated by scripts/generate-workspace-snapshot-schema.mjs. Do not edit by hand. */\n` +
  `import type { WorkspaceSnapshotSchemaGraph } from './workspaceSnapshotSchema.types';\n\n` +
  `export const workspaceSnapshotSchema = ${JSON.stringify({ root, definitions: orderedDefinitions }, null, 2)} as const satisfies WorkspaceSnapshotSchemaGraph;\n`;

if (checkOnly) {
  if (!fs.existsSync(outputFile) || fs.readFileSync(outputFile, 'utf8') !== generated) {
    console.error('Workspace snapshot schema is stale. Run npm run generate:workspace-schema.');
    process.exitCode = 1;
  } else {
    console.log(`Workspace snapshot schema is current (${nextReference} refs, ${reachableTypes} traversals).`);
  }
} else {
  fs.writeFileSync(outputFile, generated, 'utf8');
  console.log(`Wrote workspace snapshot schema (${nextReference} refs, ${reachableTypes} traversals).`);
}
