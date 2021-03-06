// ==========================================================================
// Project:   Seed - Flexible Package Manager
// Copyright: ©2009-2010 Apple Inc. All rights reserved.
// License:   Licened under MIT license (see __preamble__.js)
// ==========================================================================

if (!require.sandbox) throw "Can only load from within seed";

var CORE    = require('private/core');
var Cmds    = require('commands');
var REMOTE  = require('remote');
var SEMVER  = require('tiki').semver;

exports.summary = "Install or update a package";
exports.usage = "install [PACKAGE..PACKAGEn] [OPTIONS]";
exports.options = [
  ['-V', '--version VERSION', 'Version of package to install'],
  ['-r', '--remote REMOTE', 'Preferred remote to use for installing'],
  ['-D', '--dependencies', 'Install missing dependencies (default)'],
  ['-n', '--no-dependencies', 'Do not install missing dependencies']
];

exports.desc = [
"Installs one or more packages, including any dependencies, from a local or",
"remote source.  Pass the names of one or more packages to discover them on",
"a remote server or pass a filename of an existing package to install it.",
"\n",
"\nFor local packages, you can reference either the package directory or a zip", "or seed of the package"].join(' ');

//......................................................
// SUPPORT METHODS
//

function collectState(args, opts) {
  var ret = { dependencies: undefined, domain: 'local' };
  
  var keys = ['version', 'remote'];
  keys.forEach(function(key) {
    opts.on(key, function(k, value) { ret[key] = value; });
  });
  
  opts.on('dependencies', function() { ret.dependencies = true; });
  opts.on('no-dependencies', function() { ret.dependencies = false; });
  ret.packageIds = opts.parse(args);
  return ret ;  
}

// ..........................................................
// INSTALL JOB
// 

/*
  An install job handles the task of actually installing one or more packages
  into a repository.  Basically each package we want to install must go 
  through the following steps:

  1. Stage the package.  The package contents must be actually downloaded 
     and unzipped.  
     
  2. Resolve any dependencies.  Dependent packages must install first.
  
  3. Install into source.
*/
var InstallContext = CORE.extend(Object);
CORE.mixin(InstallContext.prototype, {
  
  init: function(source, remotes, dependencies) {
    this.source = source;
    this.remotes = remotes;
    this.includeDependencies = dependencies;
    this.descriptors = {}; // known package descriptors by packageId/vers
    this._jobs = {};
    this._cache = {};
  },

  // ..........................................................
  // INTERNAL DESCRIPTOR MANAGEMENT
  // 
  
  /**
    Returns a package descriptor in cache matching the named version.
    If exact only returns if version is an exact match.  If no match is found
    returns null.
  */
  descriptorFor: function(packageId, version, exact) {
    var desc = this.descriptors[packageId], ret, cur;
    if (!desc) return null; // not found
    
    for(var idx=0;idx<desc.length;idx++) {
      cur = desc[idx];

      // no version  or compatible version
      if (!version || (!exact && SEMVER.compatible(version, cur.version))) {
        if (!ret || (SEMVER.compare(ret.version, cur.version)<0)) ret = cur;
        
      // exact version required
      } else if (cur.version === version) ret = cur;
    }
    
    return ret ;
  },

  /**
    Adds a descriptor to the local cache.  If overlay is true or omitted,
    replaces any existing descriptor
  */
  addDescriptor: function(desc, overlay) {
    var packageId = desc.name, descriptors, idx, lim, found;
    
    descriptors = this.descriptors[packageId];
    if (!descriptors) descriptors = this.descriptors[packageId] = [];
    lim = desc.length;
    for(idx=0;!found && idx<lim; idx++) {
      if (descriptors[idx].version === desc.version) found = true;
    }
    
    if (found) {
      if (!overlay) return false;
      descriptors[idx] = desc;
    } else descriptors.push(desc);
    return true;
  },
  
  buildDescriptorFromPackage: function(pkg) {
    return {
      name:         pkg.get('name'),
      version:      SEMVER.normalize(pkg.get('version')),
      dependencies: pkg.get('dependencies') || {},
      remote:       null,
      path:         pkg.path,
      location:     'local'
    };
  },
  
  /**
    Converts packageInfo retrieved from a remote into a descriptor
  */
  buildDescriptorFromRemote: function(remotePackageInfo, remote) {
    return {
      name: remotePackageInfo.name,
      version: SEMVER.normalize(remotePackageInfo.version),
      dependencies: remotePackageInfo.dependencies || {},
      remote: remote,
      info:   remotePackageInfo,
      path: null,
      location: 'remote'
    };
  },
  
  /**
    Opens a package at the named path and extracts a package descriptor
  */
  loadDescriptor: function(path, done) {
    var context = this,
        loadPackage;
        
    path = CORE.path.normalize(path);
    loadPackage = CORE.async(function() { 
      return require.packageFor(path); 
    });
        
    loadPackage(function(err, pkg) {
      if (err) return done(err);
      var ret = context.buildDescriptorFromPackage(pkg);
      context.addDescriptor(ret, true); // replace whatever is in cache
      return done(null, ret);
    });
  },
  
  /**
    Lookup descriptor in cache.  If not found, search remotes
  */
  findDescriptor: function(packageId, version, exact, done) {
    var ret = this.descriptorFor(packageId, version, exact);
    if (ret) return done(null, ret); // found it
    
    // search remotes for packageId in order...
    if (!version || !exact) exact = null;
    var opts = { 
      name: packageId, 
      version: version, 
      exact: exact ? 'true' : 'false',
      dependencies: false //(this.includeDependencies || (this.includeDependencies===undefined)) ? 'true' : 'false'
    };

    var context = this;
    CORE.iter.find(this.remotes, function(remote, done) {
      remote.list(opts, function(err, response) {
        if (err) { Cmds.verbose('Warning: ' + err); }
        if (err || !response) return done(null, false); // not found
        response.forEach(function(packageInfo) {
          var desc = context.buildDescriptorFromRemote(packageInfo, remote);
          context.addDescriptor(desc, false); // don't overlay cache
          context.prepare(desc, CORE.noop); // can run in parallel
        });
        
        ret = context.descriptorFor(packageId, version, exact);
        return done(null, !!ret); // stop when found remote
      });
      
    })(function(err) {
      if (err) return done(err);
      else return done(null, ret);
    });
    
  },
  
  // ..........................................................
  // PREPARING
  // 
  
  /**
    Prepares a package for install.  Calls done() when package is prepared.
    Descriptor should now have a path you can use to install from.
  */
  prepare: function(desc, done) {
    var job = desc.prepareJob;
    if (!job) {
      var context = this;
      job = desc.prepareJob = CORE.once(function(done) {
        // if we already have a local path, then this package is already
        // prepared for install
        if (desc.path) return done();
        
        // Otherwise, we should have a remote that we can ask to fetch
        if (!desc.remote) {
          return done('internal error: missing remote '+CORE.inspect(desc));
        }
        
        desc.remote.fetch(desc.info, function(err, path) {
          if (!err && !path) {
            err = "Could not fetch "+desc.packageId + ' ('+desc.version+')';
          }
          if (err) return done(err);
          desc.path = path;
          return done();
        });
      });
    }
    
    job(done);
  },
    
  // ..........................................................
  // INSTALL
  // 
  
  /**
    main entry point.  install the passed packageId + version into the 
    named source.  Use the named remotes if needed to find the packageId.
    Invokes the callback when complete.
    
    You can call this several times on the same packageId ... we'll only 
    invoke them once
  */
  install: function(packageId, version, exact, force, done) {
    
    var context = this;
    
    if ('function' === typeof force) {
      done = force;
      force = false;
    }
    
    // packageId may be either a path or a simple packageId.  If it is a 
    // path then add the descriptor to the DB immediately
    CORE.iter.chain(function(done) {
      // looks like a path if it begins with ., .., or has a /
      if ((packageId[0]==='.') || (packageId.indexOf('/')>=0)) {
         context.loadDescriptor(packageId, done);
        
      // it's not a path - so try to find the descriptor in the cache or 
      // load it from a remote
      } else {
        context.findDescriptor(packageId, version, exact, done);
      }
    },

    // now we have a package descriptor.  Get an install job for this desc
    // and use it
    function(desc, done) {
      if (!desc) return done(packageId + ' not found');
      
      var job = desc.installJob;
      if (!job) {
        job = desc.installJob = CORE.once(function(done) {

          // satisfy dependencies first...
          CORE.iter.chain(function(done) {
            context.prepare(desc, function(err) {
              if (err) return done(err);
              context.installDependencies(desc, CORE.err(done));
            });

          // then open this package and install it
          }, function(done) {
            var loadPackage = CORE.async(function() {
              return require.packageFor(desc.path);
            });
            
            loadPackage(function(err, pkg) {
              if (!err & !pkg) err = packageId  + ' is invalid';
              if (err) return done(err);
              context.source.install(pkg, function(err) {
                if (err) return done(err);
                if (desc.remote) {
                  desc.remote.cleanup(desc.path, CORE.err(done));
                } else return done();
              });
            });
          })(done);
        });
      }

      job(done); // invoke callback once this particular job is done
      
    })(done);
  },
  
  /**
    Ensures all dependencies are installed before invoking done
  */
  installDependencies: function(desc, done) {
    var context = this;
    
    var includeDependencies = this.includeDependencies;
    if (includeDependencies === undefined) {
      this.includeDependencies = desc.location === 'remote';
    }
    
    if (!includeDependencies) return done(); // skip
    
    // map to array to process in parallel
    var deps = [];
    for(var packageId in desc.dependencies) {
      if (!desc.dependencies.hasOwnProperty(packageId)) continue;
      var version = desc.dependencies[packageId];
      deps.push({ packageId: packageId, version: version });
    }
    
    CORE.iter.parallel(deps, function(dep, done) {
      context.install(dep.packageId, dep.version, false, false, done);
    })(CORE.err(done));
  }
  
});

//......................................................
// COMMAND
//

exports.invoke = function(cmd, args, opts, done) {
  var state, packageIds, source, sources;
  
  state = collectState(args, opts); 
  packageIds = state.packageIds; 
  if (!packageIds || packageIds.length===0) {
    return Cmds.fail('You must name at least one package', done);
  }
  
  if (state.version && packageIds.length!==1) {
    return Cmds.fail(
      '--version switch can only be used with one package name',
      done);
  }

  // find the first repository to use for installing
  sources = require.loader.sources || [];
  sources.forEach(function(cur) {
    if (!source && cur.acceptsInstalls) source = cur;
  });
  
  if (!source) {
    return Cmds.fail("Cannot find install location", done);
  }
  
  // find remotes needed to install.  If a remote is named just use that.
  // otherwise just get all remotes
  CORE.iter.chain(function(done) {
    var remoteUrl = state.remote;
    if (remoteUrl) {
      remoteUrl = REMOTE.normalize(remoteUrl);
      REMOTE.open(remoteUrl, function(err, remote) {
        if (err) return done(err);
        if (remote) return done(null, [remote]);
        
        // if remote is unknown assume it's the default type
        REMOTE.openRemote(remoteUrl, function(err, remote) {
          if (err) return done(err);
          return done(null, [remote]);
        });
        
      });
      
    } else {
      REMOTE.remotes(done);
    }
  },

  // start a new install job and install each package id in parallel.  Invoke
  // done once the install is complete
  function(remotes, done) {
    
    var context = new InstallContext(source, remotes, state.dependencies);
    CORE.iter.parallel(packageIds, function(packageId, done) {
      context.install(packageId, state.version, true, done);  
    })(done);
    
  })(function(err) { return done(err); });
  return done();
};

