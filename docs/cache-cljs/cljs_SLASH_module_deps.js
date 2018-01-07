let fs = require('fs');
let path = require('path');
let mdeps = require('@cljs-oss/module-deps');
let nodeResolve = require('resolve');
let babylon = require('babylon');
let traverse = require('babel-traverse').default;
let enhancedResolve = require('enhanced-resolve');

let target = 'CLJS_TARGET';
let filename = fs.realpathSync(path.resolve(__dirname, 'JS_FILE'));
let mainFields =
    target === 'nodejs' ? ['module', 'main'] : ['module', 'browser', 'main'];

// https://github.com/egoist/konan
let getDeps = function (src, {dynamicImport = true, parse = {sourceType: 'module', plugins: '*'}} = {}) {
    const modules = {strings: [], expressions: []};

    let ast;

    if (typeof src === 'string') {
        const moduleRe = /\b(require|import)\b/;

        if (!moduleRe.test(src)) {
            return modules;
        }

        ast = babylon.parse(src, parse);
    } else {
        ast = src;
    }

    traverse(ast, {
        enter(path) {
            if (path.node.type === 'CallExpression') {
                const callee = path.get('callee');
                const isDynamicImport = dynamicImport && callee.isImport();
                if (callee.isIdentifier({name: 'require'}) || isDynamicImport) {
                    const arg = path.node.arguments[0];
                    if (arg.type === 'StringLiteral') {
                        modules.strings.push(arg.value);
                    } else {
                        modules.expressions.push(src.slice(arg.start, arg.end));
                    }
                }
            } else if (path.node.type === 'ImportDeclaration') {
                modules.strings.push(path.node.source.value);
            } else if (path.node.type === 'ExportNamedDeclaration' && path.node.source) {
                // this branch handles `export ... from` - David
                modules.strings.push(path.node.source.value);
            }
        }
    });

    return modules;
};

let resolver = enhancedResolve.create({
  fileSystem: new enhancedResolve.CachedInputFileSystem(
    new enhancedResolve.NodeJsInputFileSystem(),
    4000
  ),
  extensions: ['.js', '.json'],
  mainFields: mainFields,
  moduleExtensions: ['.js', '.json'],
});

let md = mdeps({
  resolve: function(id, parentOpts, cb) {
    // set the basedir properly so we don't try to resolve requires in the Closure
    // Compiler processed `node_modules` folder.
    parentOpts.basedir =
      parentOpts.filename === filename
        ? path.resolve(__dirname)
        : path.dirname(parentOpts.filename);

    resolver(parentOpts.basedir, id, cb);
  },
  filter: function(id) {
    return !(target === 'nodejs' && nodeResolve.isCore(id));
  },
  detect: function(src) {
    let deps = getDeps(src);

    return deps.strings;
  }
});

function getPackageJsonMainEntry(pkgJson) {
  for (let i = 0; i < mainFields.length; i++) {
    let entry = mainFields[i];

    if (pkgJson[entry] != null) {
      return pkgJson[entry];
    }
  }
  return null;
}

let pkgJsons = [];
let deps_files = {};

md.on('package', function(pkg) {
  // we don't want to include the package.json for users' projects
  if (/node_modules/.test(pkg.__dirname)) {
    let pkgJson = {
      file: path.join(pkg.__dirname, 'package.json'),
    };

    if (pkg.name != null) {
      pkgJson.provides = [pkg.name];
    }

    let pkgJsonMainEntry = getPackageJsonMainEntry(pkg);
    if (pkgJsonMainEntry != null) {
      pkgJson.mainEntry = path.join(pkg.__dirname, pkgJsonMainEntry);
    }

    pkgJsons.push(pkgJson);
  }
});

md.on('file', function (file) {
    deps_files[file] = {file: file};
});

md.on('end', function () {
    for (let i = 0; i < pkgJsons.length; i++) {
        let pkgJson = pkgJsons[i];

        if (deps_files[pkgJson.mainEntry] != null && pkgJson.provides != null) {
            deps_files[pkgJson.mainEntry].provides = pkgJson.provides;
        }

        deps_files[pkgJson.file] = {file: pkgJson.file};
    }

    let values = [];
    for (let key in deps_files) {
        let dep = deps_files[key];

        // add provides to files that are not `package.json`s
        if (
            !/node_modules[/\\](@[^/\\]+?[/\\])?[^/\\]+?[/\\]package\.json$/.test(
                dep.file
            )
        ) {
            if (dep.file.indexOf('node_modules') !== -1) {
                let providedModule = dep.file
                    .substring(dep.file.lastIndexOf('node_modules'))
                    .replace(/\\/g, '/')
                    .replace('node_modules/', '');

                dep.provides = dep.provides || [];
                dep.provides.push(
                    providedModule,
                    providedModule.replace(/\.js(on)?$/, '')
                );

                let indexReplaced = providedModule.replace(/\/index\.js(on)?$/, '');

                if (
                    /\/index\.js(on)?$/.test(providedModule) &&
                    dep.provides.indexOf(indexReplaced) === -1
                ) {
                    dep.provides.push(indexReplaced);
                }
            }
        }

        values.push(dep);
    }

    process.stdout.write(JSON.stringify(values));
});

md.end({
    file: filename
});

md.resume();