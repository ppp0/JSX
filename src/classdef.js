var Class = require("./Class");
var Type = require("./type");
eval(Class.$import("./util"));

"use strict";

var BlockContext = exports.BlockContext = Class.extend({

	constructor: function (localVariableStatuses, statement) {
		this.localVariableStatuses = localVariableStatuses;
		this.statement = statement;
	}

});

var AnalysisContext = exports.AnalysisContext = Class.extend({

	constructor: function (errors, parser, instantiateTemplate) {
		this.errors = errors;
		this.parser = parser;
		this.instantiateTemplate = instantiateTemplate;
		this.funcDef = null;
		this.blockStack = null;
	},

	clone: function () {
		// NOTE: does not clone the blockStack for now (since there is no such use case)
		return new AnalysisContext(this.errors, this.parser, this.instantiateTemplate).setFuncDef(this.funcDef);
	},

	setFuncDef: function (funcDef) {
		this.funcDef = funcDef;
		return this;
	},

	initBlockStack: function (localVariableStatuses) {
		this.blockStack = [ new BlockContext(localVariableStatuses, null) ];
		return this;
	},

	getTopBlock: function () {
		return this.blockStack[this.blockStack.length - 1];
	}

});

var ClassDefinition = exports.ClassDefinition = Class.extend({

	$IS_CONST: 1,
	$IS_ABSTRACT: 2,
	$IS_FINAL: 4,
	$IS_STATIC: 8,
	$IS_NATIVE: 16,
	$IS_OVERRIDE: 32,
	$IS_INTERFACE: 64,
	$IS_MIXIN: 128,

	constructor: function (token, className, flags, extendName, implementNames, members, objectTypesUsed) {
		this._token = token;
		this._className = className;
		this._outputClassName = null;
		this._flags = flags;
		this._extendName = extendName;
		this._extendClassDef = null;
		this._implementNames = implementNames;
		this._implementClassDefs = [];
		this._members = members;
		this._objectTypesUsed = objectTypesUsed;
	},

	serialize: function () {
		// FIXME implement in a way that is compatible with JSX
		return {
			"token"      : this._token,
			"name"       : this._className,
			"flags"      : this._flags,
			"extends"    : Util.serializeNullable(this._extendClassDef),
			"implements" : Util.serializeArray(this._implementClassDefs),
			"members"    : Util.serializeArray(this._members)
		};
	},

	$serialize: function (classDefs) {
		var s = [];
		for (var i = 0; i < classDefs.length; ++i)
			s[i] = classDefs[i].serialize();
		return JSON.stringify(s, null, 2);
	},

	getToken: function () {
		return this._token;
	},

	className: function () {
		return this._className;
	},

	setOutputClassName: function (name) {
		this._outputClassName = name;
	},

	getOutputClassName: function () {
		return this._outputClassName;
	},

	flags: function () {
		return this._flags;
	},

	extendClassDef: function () {
		return this._extendClassDef;
	},

	implementClassDefs: function () {
		return this._implementClassDefs;
	},

	members: function () {
		return this._members;
	},

	$GET_MEMBER_MODE_ALL: 0, // looks for functions or variables from the class and all super classes
	$GET_MEMBER_MODE_CLASS_ONLY: 1, // looks for functions or variables within the class
	$GET_MEMBER_MODE_SUPER: 2, // looks for functions with body in super classes
	$GET_MEMBER_MODE_FUNCTION_WITH_BODY: 3, // looks for function with body
	
	getMemberTypeByName: function (name, mode) {
		// returns an array to support function overloading
		var types = [];
		this._getMemberTypesByName(types, name, mode);
		switch (types.length) {
		case 0:
			return null;
		case 1:
			return types[0];
		default:
			return new Type.FunctionChoiceType(types);
		}
	},

	_getMemberTypesByName: function (types, name, mode) {
		if (mode != ClassDefinition.GET_MEMBER_MODE_SUPER) {
			for (var i = 0; i < this._members.length; ++i) {
				var member = this._members[i];
				if (name == member.name()) {
					if (member instanceof MemberVariableDefinition) {
						if ((member.flags() & ClassDefinition.IS_OVERRIDE) == 0) {
							var type = member.getType();
							// ignore member variables that failed in type deduction (already reported as a compile error)
							// it is guranteed by _assertMemberVariableIsDefinable that there would not be a property with same name using different type, so we can use the first one (declarations might be found more than once using the "abstract" attribute)
							if (type != null && types.length == 0)
								types[0] = type;
						}
					} else if (member instanceof MemberFunctionDefinition) {
						// member function
						if (member.getStatements() != null || mode != ClassDefinition.GET_MEMBER_MODE_NOT_ABSTRACT) {
							for (var j = 0; j < types.length; ++j)
								if (Util.typesAreEqual(member.getArgumentTypes(), types[j].getArgumentTypes()))
									break;
							if (j == types.length)
								types.push(member.getType());
						}
					} else {
						throw new Error("logic flaw");
					}
				}
			}
		} else {
			// for searching super classes, change mode GET_MEMBER_MODE_SUPER to GET_MEMBER_MODE_NOT_ABSTRACT
			mode = ClassDefinition.GET_MEMBER_MODE_FUNCTION_WITH_BODY;
		}
		if (mode != ClassDefinition.GET_MEMBER_MODE_CLASS_ONLY) {
			if (this._extendClassDef != null)
				this._extendClassDef._getMemberTypesByName(types, name, mode);
			for (var i = 0; i < this._implementClassDefs.length; ++i)
				this._implementClassDefs[i]._getMemberTypesByName(types, name, mode);
		}
	},

	resolveTypes: function (context) {
		// resolve extends
		if (this._extendName != null) {
			var baseClass = this._extendName.getClass(context);
			if (baseClass == null)
				; // error reported by getClass
			else if ((baseClass.flags() & ClassDefinition.IS_FINAL) != 0)
				context.errors.push(new CompileError(this._extendName.getToken(), "cannot extend a final class"));
			else if ((baseClass.flags() & ClassDefinition.IS_INTERFACE) != 0)
				context.errors.push(new CompileError(this._extendName.getToken(), "cannot extend an interface, use the 'implements' keyword"));
			else if ((baseClass.flags() & ClassDefinition.IS_MIXIN) != 0)
				context.errors.push(new CompileError(this._extendName.getToken(), "cannot extend an mixin, use the 'implements' keyword"));
			else
				this._extendClassDef = baseClass;
		} else if (this._className != "Object") {
			var baseClass = context.parser.lookup(context.errors, this._token, "Object");
			this._extendClassDef = baseClass;
		}
		// resolve implements
		for (var i = 0; i < this._implementNames.length; ++i) {
			var baseClass = this._implementNames[i].getClass(context);
			var success = true;
			if (baseClass == null) {
				// error reported by getClass
				success = false;
			} else if ((baseClass.flags() & (ClassDefinition.IS_INTERFACE | ClassDefinition.IS_MIXIN)) == 0) {
				context.errors.push(new CompileError(this._implementNames[i].getToken(), "cannot implement a class (only interfaces can be implemented)"));
				success = false;
			} else {
				for (var j = 0; j < this._implementClassDefs.length; ++j) {
					if (this._implementClassDefs[j] == baseClass) {
						context.errors.push(new CompileError(this._implementNames[i].getToken(), "cannot implement the same interface more than once"));
						success = false;
						break;
					}
				}
			}
			if (success)
				this._implementClassDefs.push(baseClass);
		}
		// resolve types used
		for (var i = 0; i < this._objectTypesUsed.length; ++i)
			this._objectTypesUsed[i].resolveType(context);
	},

	analyze: function (context) {
		// prepare
		for (var i = 0; i < this._members.length; ++i) {
			var member = this._members[i];
			member.setClassDef(this);
			if (member instanceof MemberVariableDefinition)
				member.setAnalysisContext(context);
		}
		// check that the class may be extended
		if (! this._assertInheritanceIsNotInLoop(context, null, this.getToken()))
			return false;
		// check that none of the implemented mixins are implemented by the base classes
		if ((this.flags() & ClassDefinition.IS_MIXIN) != 0)
			for (var i = 0; i < this._implementClassDefs.length; ++i)
				if (! this._implementClassDefs[i]._assertMixinIsImplementable(context, this, this.getToken()))
					break;
		for (var i = 0; i < this._implementClassDefs.length; ++i) {
			if ((this._implementClassDefs[i].flags() & ClassDefinition.IS_MIXIN) != 0) {
				if (this._extendClassDef != null && ! this._extendClassDef._assertMixinIsImplementable(context, this._implementClassDefs[i], this._implementNames[i].getToken())) {
					// error found and reported
				} else {
					for (var j = 0; j < i; ++j) {
						if (! this._implementClassDefs[j]._assertMixinIsImplementable(context, this._implementClassDefs[i], this._implementNames[i].getToken())) {
							// error found and reported
						}
					}
				}
			}
		}
		// check that the properties of the class does not conflict with those in base classes or implemented interfaces
		for (var i = 0; i < this._members.length; ++i) {
			this._assertMemberIsDefinable(context, this._members[i], this, this._members[i].getToken());
		}
		// check that the properties of the implemented interfaces does not conflict with those in base classes or other implement interfaces
		for (var i = 0; i < this._implementClassDefs.length; ++i) {
			var interfaceDef = this._implementClassDefs[i];
			for (var j = 0; j < interfaceDef._members.length; ++j)
				this._assertMemberIsDefinable(context, interfaceDef._members[j], interfaceDef, this._implementNames[i].getToken());
		}
		// check that the member functions with "override" attribute are in fact overridable
		if ((this._flags & (ClassDefinition.IS_INTERFACE | ClassDefinition.IS_MIXIN)) == 0) {
			for (var i = 0; i < this._members.length; ++i)
				if (this._members[i] instanceof MemberFunctionDefinition && (this._members[i].flags() & ClassDefinition.IS_OVERRIDE) != 0)
					if (this._assertFunctionIsOverridableInBaseClasses(context, this._members[i]) === null)
						context.errors.push(new CompileError(this._members[i].getToken(), "could not find function definition in base classes / mixins to be overridden"));
			for (var i = 0; i < this._implementClassDefs.length; ++i) {
				if ((this._implementClassDefs[i].flags & ClassDefinition.IS_MIXIN) == 0)
					continue;
				var overrideFunctions = [];
				this._implementClassDefs[i]._getMembers(overrideFunctions, true, ClassDefinition.IS_OVERRIDE, ClassDefinition.IS_OVERRIDE);
				for (var j = 0; j < overrideFunctions.length; ++j) {
					var done = false;
					if (this._baseClassDef != null)
						if (this._baseClassDef._assertFunctionIsOverridable(context, overrideFunctions[j]) !== null)
							done = true;
					for (var k = 0; k < i; ++k) {
						if (this._implementClassDefs[k]._assertFunctionIsOverridable(context, overrideFunctions[j]) !== null) {
							done = true;
							break;
						}
					}
					if (! done)
						context.errors.push(new CompileError(this.getToken(), "could not find function definition to be overridden by '" + overrideFunctions[j].getClassDef().className() + "#" + overrideFunctions[j].name() + "'"));
				}
			}
		}
		// check that there are no "abstract" members for a concrete class
		if ((this._flags & (ClassDefinition.IS_ABSTRACT | ClassDefinition.IS_INTERFACE | ClassDefinition.IS_MIXIN)) == 0) {
			var abstractMembers = [];
			this._getMembers(abstractMembers, false, ClassDefinition.IS_ABSTRACT, ClassDefinition.IS_ABSTRACT);
			this._filterAbstractMembers(abstractMembers);
			if (abstractMembers.length != 0) {
				var msg = "class should be declared as 'abstract' since the following members do not have concrete definition: ";
				for (var i = 0; i < abstractMembers.length; ++i) {
					if (i != 0)
						msg += ", ";
					msg += abstractMembers[i].getClassDef().className() + "#" + abstractMembers[i].name();
				}
				context.errors.push(new CompileError(this.getToken(), msg));
			}
		}
		// analyze the member functions, analysis of member variables is performed lazily (and those that where never analyzed will be removed by dead code elimination)
		for (var i = 0; i < this._members.length; ++i) {
			var member = this._members[i];
			if (member instanceof MemberFunctionDefinition)
				member.analyze(context, this);
		}
	},

	analyzeUnusedVariables: function () {
		for (var i = 0; i < this._members.length; ++i) {
			var member = this._members[i];
			if (member instanceof MemberVariableDefinition)
				member.getType();
		}
	},

	isConvertibleTo: function (classDef) {
		if (this == classDef)
			return true;
		if (this._extendClassDef != null && this._extendClassDef.isConvertibleTo(classDef))
			return true;
		for (var i = 0; i < this._implementClassDefs.length; ++i)
			if (this._implementClassDefs[i].isConvertibleTo(classDef))
				return true;
		return false;
	},

	_assertInheritanceIsNotInLoop: function (context, classDef, token) {
		if (classDef == this) {
			context.errors.push(new CompileError(token, "class inheritance is in a loop"));
			return false;
		}
		if (classDef == null)
			classDef = this;
		if (this._extendClassDef != null && ! this._extendClassDef._assertInheritanceIsNotInLoop(context, classDef, token))
			return false;
		for (var i = 0; i < this._implementClassDefs.length; ++i)
			if (! this._implementClassDefs[i]._assertInheritanceIsNotInLoop(context, classDef, token))
				return false;
		return true;
	},

	_assertMixinIsImplementable: function (context, classDef, token) {
		for (var i = 0; i < this._implementClassDefs.length; ++i) {
			if (this._implementClassDefs[i] == classDef) {
				context.errors.push(new CompileError(token, "cannot implement mixin '" + classDef.className() + "' already implemented by '" + this.className() + "'"));
				return false;
			}
		}
		return true;
	},

	_assertMemberIsDefinable: function (context, member, memberClassDef, token) {
		if ((member.flags() & ClassDefinition.IS_STATIC) != 0)
			return true;
		for (var numImplementsToCheck = 0; numImplementsToCheck < this._implementClassDefs.length; ++numImplementsToCheck)
			if (memberClassDef == this._implementClassDefs[numImplementsToCheck])
				break;
		var isCheckingSibling = numImplementsToCheck != this._implementClassDefs.length;
		if (member instanceof MemberVariableDefinition) {
			if (this._extendClassDef != null && ! this._extendClassDef._assertMemberVariableIsDefinable(context, member, memberClassDef, token))
				return false;
			for (var i = 0; i < numImplementsToCheck; ++i) {
				if (! this._implementClassDefs[i]._assertMemberVariableIsDefinable(context, member, memberClassDef, token))
					return false;
			}
		} else { // function
			if (this._extendClassDef != null && ! this._extendClassDef._assertMemberFunctionIsDefinable(context, member, memberClassDef, token, false))
				return false;
			for (var i = 0; i < numImplementsToCheck; ++i) {
				if (memberClassDef != this._implementClassDefs[i] && ! this._implementClassDefs[i]._assertMemberFunctionIsDefinable(context, member, memberClassDef, token, isCheckingSibling))
					return false;
			}
		}
		return true;
	},

	_assertMemberVariableIsDefinable: function (context, member, memberClassDef, token) {
		for (var i = 0; i < this._members.length; ++i) {
			if (this._members[i].name() == member.name()) {
				if ((this._members[i].flags() & ClassDefinition.IS_ABSTRACT) == 0) {
					context.errors.push(new CompileError(token, "cannot define property '" + memberClassDef.className() + "#" + member.name() + "', the name is already used in '" + this.className() + "'"));
					return false;
				}
				if (! this._members[i].getType().equals(member.getType())) {
					context.errors.push(new CompileError(token, "cannot override property '" + this.className() + "#" + member.name() + "' of type '" + this._members[i].getType().toString() + "' in class '" + memberClassDef.className() + "' with different type '" + member.getType().toString() + "'"));
					return false;
				}
			}
		}
		if (this._extendClassDef != null && ! this._extendClassDef._assertMemberVariableIsDefinable(context, member, memberClassDef, token))
			return false;
		for (var i = 0; i < this._implementClassDefs.length; ++i)
			if (! this._implementClassDefs[i]._assertMemberVariableIsDefinable(context, member, memberClassDef, token))
				return false;
		return true;
	},

	_assertMemberFunctionIsDefinable: function (context, member, memberClassDef, token, reportOverridesAsWell) {
		if (member.name() == "constructor")
			return true;
		for (var i = 0; i < this._members.length; ++i) {
			if (this._members[i].name() != member.name())
				continue;
			// property with the same name has been found, we can tell yes or no now
			if (this._members[i] instanceof MemberVariableDefinition) {
				context.errors.push(new CompileError(token, "cannot define property '" + memberClassDef.className() + "#" + member.name() + "', the name is already used in '" + this.className() + "'"));
				return false;
			}
			if (! Util.typesAreEqual(this._members[i].getArgumentTypes(), member.getArgumentTypes()))
				continue;
			if ((member.flags() & ClassDefinition.IS_OVERRIDE) == 0) {
				context.errors.push(new CompileError(member.getToken(), "overriding functions must have 'override' attribute set (defined in base class '" + this.className() + "')"));
				return false;
			}
			if (reportOverridesAsWell && (this._members[i].flags() & ClassDefinition.IS_OVERRIDE) != 0) {
				context.errors.push(new CompileError(member.getToken(), "definition of the function conflicts with sibling mix-in '" + this.className() + "'"));
				return false;
			}
			// assertion of function being overridden does not have 'final' attribute is done by assertFunctionIsOverridable
			return true;
		}
		// delegate to base classes
		if (this._extendClassDef != null && ! this._extendClassDef._assertMemberFunctionIsDefinable(context, member, memberClassDef, token, false))
			return false;
		for (var i = 0; i < this._implementClassDefs.length; ++i)
			if (! this._implementClassDefs[i]._assertMemberFunctionIsDefinable(context, member, memberClassDef, token, false))
				return false;
		return true;
	},

	_assertFunctionIsOverridable: function (context, member) {
		for (var i = 0; i < this._members.length; ++i) {
			if (this._members[i].name() == member.name()
				&& this._members[i] instanceof MemberFunctionDefinition
				&& (this._members[i] & ClassDefinition.IS_STATIC) == 0
				&& Util.typesAreEqual(this._members[i].getArgumentTypes(), member.getArgumentTypes())) {
				if ((this._members[i].flags() & ClassDefinition.IS_FINAL) != 0) {
					context.errors.push(new CompileError(member.getToken(), "cannot override final function defined in class '" + this.className() + "'"));
					return false;
				} else {
					return true;
				}
			}
		}
		return this._assertFunctionIsOverridableInBaseClasses(context, member);
	},

	_assertFunctionIsOverridableInBaseClasses: function (context, member) {
		if (this._extendClassDef != null) {
			var ret = this._extendClassDef._assertFunctionIsOverridable(context, member);
			if (ret !== null)
				return ret;
		}
		for (var i = 0; i < this._implementClassDefs.length; ++i) {
			var ret = this._implementClassDefs[i]._assertFunctionIsOverridable(context, member);
			if (ret !== null)
				return ret;
		}
		return null;
	},

	_getMembers: function (list, functionOnly, flagsMask, flagsMaskMatch) {
		// fill in the definitions of base classes
		if (this._baseClassDef != null)
			this._baseClassDef._getMembers(list, functionOnly, flagsMask, flagsMaskMatch);
		for (var i = 0; i < this._implementClassDefs.length; ++i)
			this._implementClassDefs[i]._getMembers(list, functionOnly, flagsMask, flagsMaskMatch);
		// fill in the definitions of members
		for (var i = 0; i < this._members.length; ++i) {
			if (functionOnly && ! (this._members[i] instanceof MemberFunctionDefinition))
				continue;
			if ((this._members[i].flags() & flagsMask) != flagsMaskMatch)
				continue;
			for (var j = 0; j < list.length; ++j)
				if (list[j].name() == this._members[i].name())
					if ((list[j] instanceof MemberVariableDefinition) || Util.typesAreEqual(list[j].getArgumentTypes(), this._members[j].getArgumentTypes()))
						break;
			if (j == list.length)
				list.push(this._members[i]);
		}
	},

	_filterAbstractMembers: function (list) {
		// filter the abstract members by using base classes
		if (list.length == 0)
			return;
		if (this._baseClassDef != null)
			this._baseClassDef._filterAbstractMembers(list);
		for (var i = 0; i < this._implementClassDefs.length; ++i)
			this._implementClassDefs[i]._filterAbstractMembers(list);
		for (var i = 0; i < this._members.length; ++i) {
			if ((this._members[i].flags() & ClassDefinition.IS_ABSTRACT) != 0)
				continue;
			for (var j = 0; j < list.length; ++j)
				if (list[j].name() == this._members[i].name())
					if ((list[j] instanceof MemberVariableDefinition) || Util.typesAreEqual(list[j].getArgumentTypes(), this._members[i].getArgumentTypes()))
						break;
			if (j != list.length) {
				list.splice(j, 1);
				if (list.length == 0)
					break;
			}
		}
	},

	hasDefaultConstructor: function () {
		var hasCtorWithArgs = false;
		for (var i = 0; i < this._members.length; ++i) {
			var member = this._members[i];
			if (member.name() == "constructor" && (member.flags() & ClassDefinition.IS_STATIC) == 0 && member instanceof MemberFunctionDefinition) {
				if (member.getArguments().length == 0)
					return true;
				hasCtorWithArgs = true;
			}
		}
		return ! hasCtorWithArgs;
	}

});

// abstract class deriving Member(Function|Variable)Definition
var MemberDefinition = exports.MemberDefinition = Class.extend({

	constructor: function (token, nameToken, flags) {
		this._token = token;
		this._nameToken = nameToken; // may be null
		if(typeof(nameToken) === "string") throw new Error("nameToken must be a Token object or null!");
		this._flags = flags;
		this._classDef = null;
	},

	// token of "function" or "var"
	getToken: function () {
		return this._token;
	},

	getNameToken: function () {
		return this._nameToken;
	},

	name: function () {
		return this._nameToken.getValue();
	},

	flags: function () {
		return this._flags;
	},

	getClassDef: function () {
		return this._classDef;
	},

	setClassDef: function (classDef) {
		this._classDef = classDef;
	}

});

var MemberVariableDefinition = exports.MemberVariableDefinition = MemberDefinition.extend({

	$NOT_ANALYZED: 0,
	$IS_ANALYZING: 1,
	$ANALYZE_SUCEEDED: 2,
	$ANALYZE_FAILED: 3,

	constructor: function (token, name, flags, type, initialValue) {
		MemberDefinition.call(this, token, name, flags);
		this._type = type; // may be null
		this._initialValue = initialValue; // may be null
		this._analyzeState = MemberVariableDefinition.NOT_ANALYZED;
		this._analysisContext = null;
	},

	instantiate: function (instantiationContext) {
		var type = this._type.instantiate(instantiationContext);
		return new MemberVariableDefinition(this._token, this._nameToken, this._flags, type, this._initialValue);
	},

	serialize: function () {
		return {
			"name"         : this.name(),
			"flags"        : this.flags(),
			"type"         : this._type.serialize(),
			"initialValue" : Util.serializeNullable(this._initialValue)
		};
	},

	setAnalysisContext: function (context) {
		this._analysisContext = context.clone();
	},

	getType: function () {
		switch (this._analyzeState) {
		case MemberVariableDefinition.NOT_ANALYZED:
			try {
				this._analyzeState = MemberVariableDefinition.IS_ANALYZING;
				if (this._initialValue != null) {
					if (! this._initialValue.analyze(this._analysisContext))
						return;
					var ivType = this._initialValue.getType();
					if (this._type == null) {
						this._type = ivType;
					} else if (! this._type.equals(ivType)) {
						this._analysisContext.errors.push(new CompileError(this._nameToken,
							"the variable is declared as '" + this._type.toString() + "' but initial value is '" + ivType.toString() + "'"));
					}
				}
				this._analyzeState = MemberVariableDefinition.ANALYZE_SUCEEDED;
			} finally {
				if (this._analyzeState != MemberVariableDefinition.ANALYZE_SUCEEDED)
					this._analyzeState = MemberVariableDefinition.ANALYZE_FAILED;
			}
			break;
		case MemberVariableDefinition.IS_ANALYZING:
			this._analysisContext.errors.push(new CompileError(this._token,
				"please declare type of variable '" + this.name() + "' (detected recursion while trying to reduce type)"));
			break;
		default:
			break;
		}
		return this._type;
	},

	getInitialValue: function () {
		return this._initialValue;
	}

});

var MemberFunctionDefinition = exports.MemberFunctionDefinition = MemberDefinition.extend({

	constructor: function (token, name, flags, returnType, args, locals, statements, closures) {
		MemberDefinition.call(this, token, name, flags);
		this._returnType = returnType;
		this._args = args;
		this._locals = locals;
		this._statements = statements;
		this._closures = closures;
		this._parent = null;
		this._classDef = null;
		if (this._closures != null) {
			for (var i = 0; i < this._closures.length; ++i)
				this._closures[i].setParent(this);
		}
	},

	instantiate: function (instantiationContext) {
		if (this._statements != null)
			throw new Error("template instantiation of function body is not supported (yet)");
		var returnType = this._returnType.instantiate(instantiationContext);
		if (returnType == null)
			return null;
		var args = [];
		for (var i = 0; i < this._args.length; ++i) {
			var arg = this._args[i].instantiate(instantiationContext);
			if (arg == null)
				return null;
			args[i] = arg;
		}
		return new MemberFunctionDefinition(this._token, this._nameToken, this._flags, returnType, args, null, null);
	},

	serialize: function () {
		return {
			"name"       : this.name(),
			"flags"      : this.flags(),
			"returnType" : this._returnType.serialize(),
			"args"       : Util.serializeArray(this._args),
			"locals"     : Util.serializeArray(this._locals),
			"statements" : Util.serializeArray(this._statements)
		};
	},

	analyze: function (context) {
		// return if is abtract (wo. function body) or is native
		if (this._statements == null)
			return;

		// setup context
		var context = context.clone().setFuncDef(this)
			.initBlockStack(new LocalVariableStatuses(this, this._parent != null ? context.getTopBlock().localVariableStatuses : null));

		// do the checks
		for (var i = 0; i < this._statements.length; ++i)
			if (! this._statements[i].analyze(context))
				break;

		// check that from the constructor, all constructors with non-zero
		// arguments are called, and that the calls are in the implemented order
		if (this.getNameToken() == null || this.name() != "constructor")
			return;

		// constructor
		var Statement = require("./statement"); // seems that we need to delay the load
		var nextConstructorIndex = -1;
		for (var i = 0; i < this._statements.length; ++i) {
			var statement = this._statements[i];
			if (! (statement instanceof Statement.ConstructorInvocationStatement))
				break;
			for (; nextConstructorIndex < this._classDef.implementClassDefs().length; ++nextConstructorIndex) {
				var baseClassDef = nextConstructorIndex == -1 ? this._classDef.extendClassDef() : this._classDef.implementClassDefs()[nextConstructorIndex];
				if (baseClassDef == statement.getConstructingClassDef())
					break;
				// constructor of baseClassDef is not called; assert that it has a zero-argument constructor (or has no constructor at all)
				if (! baseClassDef.hasDefaultConstructor())
					context.errors.push(new CompileError(statement.getQualifiedName().getToken(), "constructor of class '" + baseClassDef.className() + "' should be called prior to the statement"));
			}
			if (nextConstructorIndex == this._classDef.implementClassDefs().length) {
				context.errors.push(new CompileError(statement.getQualifiedName().getToken(), "constructors should be called in the order the base classes are extended / implemented"));
				break;
			}
			++nextConstructorIndex;
		}
		for (; nextConstructorIndex < this._classDef.implementClassDefs().length; ++nextConstructorIndex) {
			var baseClassDef = nextConstructorIndex == -1 ? this._classDef.extendClassDef() : this._classDef.implementClassDefs()[nextConstructorIndex];
			if (! baseClassDef.hasDefaultConstructor())
					context.errors.push(new CompileError(this._token, "constructor of class '" + baseClassDef.className() + "' should be called explicitely"));
		}
	},

	getReturnType: function () {
		return this._returnType;
	},

	getArguments: function () {
		return this._args;
	},

	getArgumentTypes: function () {
		var argTypes = [];
		for (var i = 0; i < this._args.length; ++i)
			argTypes[i] = this._args[i].getType();
		return argTypes;
	},

	getParent: function () {
		return this._parent;
	},

	setParent: function (parent) {
		this._parent = parent;
	},

	// return list of local variables (omitting arguments)
	getLocals: function () {
		return this._locals;
	},

	getStatements: function () {
		return this._statements;
	},

	getClosures: function () {
		return this._closures;
	},

	// return an argument or a local variable
	getLocal: function (name) {
		for (var i = 0; i < this._locals.length; ++i) {
			var local = this._locals[i];
			if (local.getName().getValue() == name)
				return local;
		}
		for (var i = 0; i < this._args.length; ++i) {
			var arg = this._args[i];
			if (arg.getName().getValue() == name)
				return arg;
		}
		if (this._parent != null)
			return this._parent.getLocal(name);
		return null;
	},

	getType: function () {
		return (this._flags & ClassDefinition.IS_STATIC) != 0
			? new Type.StaticFunctionType(this._returnType, this.getArgumentTypes(), false)
			: new Type.MemberFunctionType(new Type.ObjectType(this._classDef), this._returnType, this.getArgumentTypes(), false);
	}

});

var LocalVariable = exports.LocalVariable = Class.extend({

	constructor: function (name, type) {
		this._name = name;
		this._type = type;
	},

	serialize: function () {
		return [
			this._name,
			Util.serializeNullable(this._type)
		];
	},

	getName: function () {
		return this._name;
	},

	getType: function () {
		return this._type;
	},

	setType: function (type) {
		if (this._type != null)
			throw Error("type is already set");
		// implicit declarations of "int" is not supported
		if (type.equals(Type.integerType))
			type = Type.numberType;
		this._type = type;
	},

	toString: function () {
		return this._name + " : " + this._type;
	}
});

var ArgumentDeclaration = exports.ArgumentDeclaration = LocalVariable.extend({

	constructor: function (name, type) {
		LocalVariable.prototype.constructor.call(this, name, type);
	},

	instantiate: function (instantiationContext) {
		var type = this._type.instantiate(instantiationContext);
		return new ArgumentDeclaration(this._name, type);
	}

});

var LocalVariableStatuses = exports.LocalVariableStatuses = Class.extend({

	$UNSET: 0,
	$ISSET: 1,
	$MAYBESET: 2,

	constructor: function () {
		this._statuses = {};

		switch (arguments.length) {

		case 2: // (funcDef : MemberFunctionDefinition, baseStatuses : LocalVariableStatuses)
			var funcDef = arguments[0];
			var base = arguments[1];
			if (base != null)
				this._copyFrom(base);
			var args = funcDef.getArguments();
			for (var i = 0; i < args.length; ++i)
				this._statuses[args[i].getName().getValue()] = LocalVariableStatuses.ISSET;
			var locals = funcDef.getLocals();
			for (var i = 0; i < locals.length; ++i)
				this._statuses[locals[i].getName().getValue()] = LocalVariableStatuses.UNSET;
			break;

		case 1: // (srcStatus : LocalVariableStatus)
			this._copyFrom(arguments[0]);
			break;

		default:
			throw new Error("logic flaw");
		}
	},

	clone: function () {
		return new LocalVariableStatuses(this);
	},

	merge: function (that) {
		var ret = this.clone();
		for (var k in ret._statuses) {
			if (ret._statuses[k] == LocalVariableStatuses.UNSET && that._statuses[k] == LocalVariableStatuses.UNSET) {
				// UNSET
			} else if (ret._statuses[k] == LocalVariableStatuses.ISSET && that._statuses[k] == LocalVariableStatuses.ISSET) {
				// ISSET
			} else {
				// MAYBESET
				ret._statuses[k] = LocalVariableStatuses.MAYBESET;
			}
		}
		return ret;
	},

	setStatus: function (local) {
		var name = local.getName().getValue();
		if (this._statuses[name] === undefined)
			throw new Error("logic flaw, could not find status for local variable: " + name);
		this._statuses[name] = LocalVariableStatuses.ISSET;
	},

	getStatus: function (local) {
		var name = local.getName().getValue();
		if (this._statuses[name] === undefined)
			throw new Error("logic flaw, could not find status for local variable: " + name);
		return this._statuses[name];
	},

	_copyFrom: function (that) {
		for (var k in that._statuses)
			this._statuses[k] = that._statuses[k];
	}

});

var TemplateClassDefinition = exports.TemplateClassDefinition = Class.extend({

	constructor: function (className, flags, typeArgs, extendName, implementNames, members, objectTypesUsed) {
		if (extendName != null || implementNames.length != 0)
			throw new Error("not supported");
		this._className = className;
		this._flags = flags;
		this._typeArgs = typeArgs;
		this._members = members;
		this._objectTypesUsed = objectTypesUsed;
	},

	className: function () {
		return this._className;
	},

	instantiate: function (errors, request) {
		// check number of type arguments
		if (this._typeArgs.length != request.getTypeArguments().length) {
			errors.push(new CompileError(request.getToken(), "wrong number of template arguments (expected " + this._typeArgs.length + ", got " + request.getTypes().length));
			return null;
		}
		// build context
		var instantiationContext = {
			errors: errors,
			request: request,
			typemap: {}, // string => Type
			objectTypesUsed: []
		};
		for (var i = 0; i < this._typeArgs.length; ++i)
			instantiationContext.typemap[this._typeArgs[i].getValue()] = request.getTypeArguments()[i];
		// FIXME add support for extend and implements
		var succeeded = true;
		var members = [];
		for (var i = 0; i < this._members.length; ++i) {
			var member = this._members[i].instantiate(instantiationContext);
			if (member == null)
				succeeded = false;
			members[i] = member;
		}
		// done
		if (! succeeded)
			return null;
		return new InstantiatedClassDefinition(
			this._className,
			this._flags,
			request.getTypeArguments(),
			null,
			[],
			members,
			instantiationContext.objectTypesUsed);
	}

});

var InstantiatedClassDefinition = exports.InstantiatedClassDefinition = ClassDefinition.extend({

	constructor: function (templateClassName, flags, typeArguments, extendName, implementNames, members, objectTypesUsed) {
		ClassDefinition.prototype.constructor.call(
			this,
			null,
			Type.Type.templateTypeToString(templateClassName, typeArguments),
			flags,
			extendName,
			implementNames,
			members,
			objectTypesUsed);
		this._templateClassName = templateClassName;
		this._typeArguments = typeArguments;
	},

	getTemplateClassName: function () {
		return this._templateClassName;
	},

	getTypeArguments: function () {
		return this._typeArguments;
	}

});
