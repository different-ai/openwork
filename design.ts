import React, { useState, useEffect, useRef } from 'react';
import { 
  Command, 
  Shield, 
  Zap, 
  Layout, 
  Settings, 
  ChevronRight, 
  Play, 
  CheckCircle2, 
  Circle, 
  AlertCircle, 
  FileText, 
  X, 
  Terminal, 
  Smartphone, 
  HardDrive,
  Cpu,
  MoreHorizontal,
  ArrowRight,
  Clock,
  Menu,
  Download,
  Folder,
  Plus,
  Trash2,
  LogOut,
  RefreshCcw,
  Package,
  Globe,
  ChevronDown,
  FolderPlus,
  Check,
  Search,
  Box,
  BrainCircuit,
  Wrench,
  History,
  Sparkles,
  LayoutTemplate,
  Loader2,
  MessageSquare,
  ArrowUp
} from 'lucide-react';

// --- Mock Data & Types ---

const MOCK_TEMPLATES = [
  { id: 't1', title: "Understand this workspace", description: "Explains local vs global tools", icon: "help-circle", prompt: "Explain how this workspace is configured and what tools are available locally." },
  { id: 't2', title: "Create a new skill", description: "Guide to adding capabilities", icon: "sparkles", prompt: "I want to create a new skill for this workspace. Guide me through it." },
  { id: 't3', title: "Run a scheduled task", description: "Demo of the scheduler plugin", icon: "clock", prompt: "Show me how to schedule a task to run every morning." },
  { id: 't4', title: "Turn task into template", description: "Save workflow for later", icon: "save", prompt: "Help me turn the last task into a reusable template." },
];

const MOCK_SESSIONS = [
  { id: 104, title: "Create 'Data Cleaner' Skill", status: "running", date: "2 mins ago", workspaceId: 'starter' },
  { id: 101, title: "Update Dependencies", status: "completed", date: "1 hour ago", workspaceId: 'starter' },
  { id: 102, title: "Fix CSS Bug", status: "failed", date: "Yesterday", workspaceId: 'proj_alpha' },
  { id: 103, title: "Deploy to Prod", status: "waiting", date: "Yesterday", workspaceId: 'personal_blog' },
];

const MOCK_WORKSPACES = [
  { id: 'starter', name: 'My First Workspace', path: '~/Documents/OpenWork/MyWorkspace', type: 'starter', icon: Zap },
  { id: 'proj_alpha', name: 'Project Alpha', path: '~/Documents/Code/alpha', type: 'custom', icon: Folder },
  { id: 'personal_blog', name: 'Personal Blog', path: '~/Github/blog', type: 'custom', icon: Globe },
];

const MOCK_EXTENSIONS = {
  plugins: [
    { id: 'p1', name: 'OpenCode Scheduler', version: '0.9.0', description: 'Run tasks on a cron schedule.', scope: 'workspace', status: 'active' },
    { id: 'p2', name: 'Browser Automation', version: '1.2.0', description: 'Headless browser control.', scope: 'global', status: 'active' },
    { id: 'p3', name: 'Python Runtime', version: '3.11.0', description: 'Execute Python scripts locally.', scope: 'workspace', status: 'active' },
  ],
  skills: [
    { id: 's1', name: 'Workspace Guide', description: 'Teaches you how to use this workspace.', scope: 'workspace', status: 'active' },
    { id: 's2', name: 'Meeting Summarizer', description: 'Extracts action items from transcripts.', scope: 'global', status: 'active' },
  ]
};

// --- Components ---

const OpenWorkLogo = ({ size = 24, className = "" }) => (
  <svg 
    width={size} 
    height={size} 
    viewBox="0 0 24 24" 
    fill="none" 
    xmlns="http://www.w3.org/2000/svg" 
    className={className}
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3" className="opacity-100" />
    <path d="M21 3L12 12" />
    <path d="M16.5 3H21V7.5" />
  </svg>
);

const Button = ({ children, variant = "primary", className = "", onClick, disabled }) => {
  const baseStyle = "px-4 py-2.5 rounded-xl font-medium transition-all duration-200 flex items-center justify-center gap-2 active:scale-95 text-sm";
  const variants = {
    primary: "bg-white text-black hover:bg-gray-100 shadow-lg shadow-white/5",
    secondary: "bg-zinc-800 text-zinc-100 hover:bg-zinc-700 border border-zinc-700/50",
    ghost: "bg-transparent text-zinc-400 hover:text-white hover:bg-zinc-800/50",
    danger: "bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20",
    outline: "border border-zinc-700 text-zinc-300 hover:border-zinc-500 bg-transparent",
  };

  return (
    <button 
      onClick={onClick} 
      disabled={disabled}
      className={`${baseStyle} ${variants[variant]} ${disabled ? 'opacity-50 cursor-not-allowed' : ''} ${className}`}
    >
      {children}
    </button>
  );
};

const StatusBadge = ({ status }) => {
  const styles = {
    completed: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    running: "bg-blue-500/10 text-blue-400 border-blue-500/20 animate-pulse",
    waiting: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    failed: "bg-red-500/10 text-red-400 border-red-500/20",
    stopped: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
  };

  return (
    <span className={`text-xs px-2 py-0.5 rounded-full border ${styles[status] || styles.stopped} flex items-center gap-1.5`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current"></span>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
};

// --- Workspace Components ---

const WorkspaceChip = ({ activeWorkspace, onClick }) => {
  const Icon = activeWorkspace.icon || Folder;
  return (
    <button 
      onClick={onClick}
      className="flex items-center gap-2 pl-3 pr-2 py-1.5 bg-zinc-900 border border-zinc-800 rounded-lg hover:border-zinc-700 hover:bg-zinc-800 transition-all group"
    >
      <div className={`p-1 rounded ${activeWorkspace.id === 'starter' ? 'bg-amber-500/10 text-amber-500' : 'bg-indigo-500/10 text-indigo-500'}`}>
         <Icon size={14} />
      </div>
      <div className="flex flex-col items-start mr-2">
        <span className="text-xs font-medium text-white leading-none mb-0.5">{activeWorkspace.name}</span>
        <span className="text-[10px] text-zinc-500 font-mono leading-none max-w-[120px] truncate">{activeWorkspace.path}</span>
      </div>
      <ChevronDown size={14} className="text-zinc-500 group-hover:text-zinc-300" />
    </button>
  );
};

const WorkspacePicker = ({ isOpen, onClose, workspaces, activeWorkspaceId, onSelect, onCreateNew }) => {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-24 bg-black/20 backdrop-blur-[2px]" onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-800 w-full max-w-sm rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-100" onClick={e => e.stopPropagation()}>
        <div className="p-2 border-b border-zinc-800">
           <div className="relative">
             <Search size={14} className="absolute left-3 top-2.5 text-zinc-500" />
             <input type="text" placeholder="Find workspace..." className="w-full bg-zinc-950 border border-zinc-800 rounded-lg py-1.5 pl-9 pr-3 text-sm text-white focus:outline-none focus:border-zinc-700" />
           </div>
        </div>
        <div className="max-h-64 overflow-y-auto p-1">
          <div className="px-3 py-2 text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">Active</div>
          {workspaces.map(ws => {
            const Icon = ws.icon;
            return (
             <button 
               key={ws.id}
               onClick={() => { onSelect(ws.id); onClose(); }}
               className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${activeWorkspaceId === ws.id ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-white hover:bg-zinc-800/50'}`}
             >
                <Icon size={16} className={activeWorkspaceId === ws.id ? 'text-indigo-400' : 'text-zinc-500'} />
                <div className="flex-1 text-left">
                  <div className="font-medium">{ws.name}</div>
                  <div className="text-[10px] text-zinc-600 font-mono truncate max-w-[200px]">{ws.path}</div>
                </div>
                {activeWorkspaceId === ws.id && <Check size={14} className="text-indigo-400" />}
             </button>
            );
          })}
        </div>
        <div className="p-2 border-t border-zinc-800 bg-zinc-900">
           <button 
             onClick={() => { onCreateNew(); onClose(); }}
             className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors"
           >
             <Plus size={16} />
             New Workspace...
           </button>
        </div>
      </div>
    </div>
  );
};

const CreateWorkspaceModal = ({ isOpen, onClose, onConfirm }) => {
  const [step, setStep] = useState(1);
  const [template, setTemplate] = useState('starter');

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="bg-zinc-900 border border-zinc-800 w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
         <div className="p-6 border-b border-zinc-800 flex justify-between items-center bg-zinc-950">
             <div>
               <h3 className="font-semibold text-white text-lg">Create Workspace</h3>
               <p className="text-zinc-500 text-sm">Initialize a new folder-based workspace.</p>
             </div>
             <button onClick={onClose} className="hover:bg-zinc-800 p-1 rounded-full"><X size={20} className="text-zinc-500" /></button>
         </div>
         
         <div className="p-6 flex-1 overflow-y-auto space-y-8">
            <div className={`space-y-4 transition-opacity ${step === 1 ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>
               <div className="flex items-center gap-3 text-sm font-medium text-white">
                 <div className="w-6 h-6 rounded-full bg-zinc-800 flex items-center justify-center text-xs">1</div>
                 Select Folder
               </div>
               <div className="ml-9">
                  <button className="w-full border border-dashed border-zinc-700 bg-zinc-900/50 rounded-xl p-4 text-left hover:bg-zinc-800/50 hover:border-zinc-600 transition-all group">
                     <div className="flex items-center gap-3 text-zinc-400 group-hover:text-white">
                        <FolderPlus size={20} />
                        <span className="text-sm">Choose a directory...</span>
                     </div>
                  </button>
               </div>
            </div>

            <div className={`space-y-4 transition-opacity ${step >= 1 ? 'opacity-100' : 'opacity-40'}`}>
              <div className="flex items-center gap-3 text-sm font-medium text-white">
                 <div className="w-6 h-6 rounded-full bg-zinc-800 flex items-center justify-center text-xs">2</div>
                 Choose Preset
               </div>
               <div className="ml-9 grid gap-3">
                  {[
                    { id: 'starter', name: 'Starter', desc: 'Pre-configured with Scheduler & Core Tools. Best for general use.' },
                    { id: 'automation', name: 'Automation', desc: 'Optimized for background tasks and scripting.' },
                    { id: 'minimal', name: 'Minimal', desc: 'Empty project. Connects only to core engine.' }
                  ].map(t => (
                    <div 
                      key={t.id}
                      onClick={() => setTemplate(t.id)}
                      className={`p-4 rounded-xl border cursor-pointer transition-all ${template === t.id ? 'bg-indigo-500/10 border-indigo-500/50' : 'bg-zinc-900 border-zinc-800 hover:border-zinc-700'}`}
                    >
                       <div className="flex justify-between items-start">
                          <div>
                            <div className={`font-medium text-sm ${template === t.id ? 'text-indigo-400' : 'text-zinc-200'}`}>{t.name}</div>
                            <div className="text-xs text-zinc-500 mt-1">{t.desc}</div>
                          </div>
                          {template === t.id && <CheckCircle2 size={16} className="text-indigo-500" />}
                       </div>
                    </div>
                  ))}
               </div>
            </div>
         </div>

         <div className="p-6 border-t border-zinc-800 bg-zinc-950 flex justify-end gap-3">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={() => onConfirm({ name: 'New Workspace', template })}>Create Workspace</Button>
         </div>
      </div>
    </div>
  );
};

const SettingsModal = ({ isOpen, onClose, currentMode, onSwitchMode, onClearPreference }) => {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
       <div className="bg-zinc-900 border border-zinc-800 w-full max-w-md rounded-2xl shadow-2xl overflow-hidden">
          <div className="p-4 border-b border-zinc-800 flex justify-between items-center">
             <h3 className="font-semibold text-white">Settings</h3>
             <button onClick={onClose} className="hover:bg-zinc-800 p-1 rounded-full"><X size={20} className="text-zinc-500" /></button>
          </div>
          <div className="p-6 space-y-6">
             <div>
                <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider block mb-2">Current Mode</label>
                <div className="flex items-center justify-between bg-zinc-950 p-3 rounded-xl border border-zinc-800">
                   <div className="flex items-center gap-3">
                      <div className={`p-2 rounded-lg ${currentMode === 'host' ? 'bg-indigo-500/10 text-indigo-400' : 'bg-emerald-500/10 text-emerald-400'}`}>
                        {currentMode === 'host' ? <HardDrive size={18} /> : <Smartphone size={18} />}
                      </div>
                      <span className="capitalize text-sm font-medium text-white">{currentMode} Mode</span>
                   </div>
                   <Button variant="outline" className="text-xs h-8 py-0 px-3" onClick={onSwitchMode}>Switch</Button>
                </div>
             </div>
             <div>
                <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider block mb-2">Startup Preference</label>
                <Button variant="secondary" className="w-full justify-between group" onClick={onClearPreference}>
                   <span className="text-zinc-300">Reset Default Startup Mode</span>
                   <RefreshCcw size={14} className="text-zinc-500 group-hover:rotate-180 transition-transform" />
                </Button>
             </div>
          </div>
       </div>
    </div>
  );
};

// --- Main Views ---

const ExtensionsView = ({ activeWorkspace, onCreateSkill }) => {
  const [tab, setTab] = useState('skills'); // 'plugins' | 'skills'

  return (
    <div className="flex h-full bg-zinc-950 text-white">
      <div className="flex-1 overflow-y-auto p-8 max-w-4xl mx-auto space-y-8">
        
        <header className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold">Extensions</h2>
            <p className="text-zinc-400 text-sm">Capabilities available to your sessions.</p>
          </div>
          <div className="bg-zinc-900 p-1 rounded-xl flex gap-1 border border-zinc-800">
             <button onClick={() => setTab('skills')} className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${tab === 'skills' ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}>
               Skills
             </button>
             <button onClick={() => setTab('plugins')} className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${tab === 'plugins' ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}>
               Plugins
             </button>
          </div>
        </header>

        {/* Skills Tab */}
        {tab === 'skills' && (
          <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div className="bg-gradient-to-r from-indigo-900/20 to-purple-900/20 border border-indigo-500/20 rounded-2xl p-6 flex items-center justify-between">
               <div>
                  <h3 className="font-semibold text-indigo-200 mb-1">Create a Custom Skill</h3>
                  <p className="text-sm text-indigo-200/60 max-w-md">Teaches OpenCode how to perform a specific workflow in plain English.</p>
               </div>
               <Button onClick={() => onCreateSkill('Create a new skill', 'I want to create a new skill for this workspace.')} className="bg-indigo-500 hover:bg-indigo-400 text-white border-none shadow-indigo-500/20">
                  <Sparkles size={16} /> Create New Skill
               </Button>
            </div>

            <div className="grid gap-4">
               {MOCK_EXTENSIONS.skills.map(skill => (
                 <div key={skill.id} className="bg-zinc-900/40 border border-zinc-800 rounded-xl p-4 flex items-center justify-between">
                    <div className="flex items-center gap-4">
                       <div className="w-10 h-10 rounded-lg bg-zinc-800 flex items-center justify-center">
                          <BrainCircuit size={20} className="text-zinc-400" />
                       </div>
                       <div>
                          <div className="font-medium text-zinc-200">{skill.name}</div>
                          <div className="text-sm text-zinc-500">{skill.description}</div>
                       </div>
                    </div>
                    <div className="flex items-center gap-3">
                       {skill.scope === 'workspace' && (
                          <span className="text-[10px] font-mono bg-zinc-800 text-zinc-400 px-2 py-1 rounded border border-zinc-700">WORKSPACE</span>
                       )}
                       <Button variant="ghost" className="h-8 w-8 p-0"><MoreHorizontal size={16} /></Button>
                    </div>
                 </div>
               ))}
            </div>
          </div>
        )}

        {/* Plugins Tab */}
        {tab === 'plugins' && (
          <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <p className="text-sm text-zinc-500">
               Plugins provide low-level capabilities (engine primitives). They are configured in <code className="text-zinc-400 bg-zinc-900 px-1 rounded">opencode.json</code>.
            </p>
            <div className="grid gap-4">
              {MOCK_EXTENSIONS.plugins.map(plugin => (
                <div key={plugin.id} className="bg-zinc-900/40 border border-zinc-800 rounded-xl p-4 flex items-center justify-between">
                   <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-lg bg-emerald-900/20 flex items-center justify-center">
                         <Wrench size={20} className="text-emerald-500" />
                      </div>
                      <div>
                         <div className="font-medium text-zinc-200">{plugin.name}</div>
                         <div className="text-sm text-zinc-500">{plugin.description}</div>
                      </div>
                   </div>
                   <div className="flex items-center gap-3">
                      {plugin.scope === 'workspace' && (
                          <span className="text-[10px] font-mono bg-zinc-800 text-zinc-400 px-2 py-1 rounded border border-zinc-700">WORKSPACE</span>
                       )}
                       {plugin.scope === 'global' && (
                          <span className="text-[10px] font-mono bg-emerald-900/30 text-emerald-400 px-2 py-1 rounded border border-emerald-500/20">GLOBAL</span>
                       )}
                      <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
                   </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const SessionsListView = ({ onOpenSession, sessions = MOCK_SESSIONS }) => {
   return (
      <div className="flex h-full bg-zinc-950 text-white">
         <div className="flex-1 overflow-y-auto p-8 max-w-5xl mx-auto">
            <header className="mb-8">
               <h2 className="text-2xl font-bold">Global Sessions</h2>
               <p className="text-zinc-400 text-sm">Your history of tasks across all workspaces.</p>
            </header>
            
            <div className="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl overflow-hidden">
               {sessions.map((s, i) => (
                 <div onClick={() => onOpenSession(s)} key={s.id} className={`p-4 flex items-center justify-between hover:bg-zinc-800/50 transition-colors cursor-pointer ${i !== sessions.length - 1 ? 'border-b border-zinc-800/50' : ''}`}>
                   <div className="flex items-center gap-4">
                     <div className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center text-xs text-zinc-500 font-mono">
                       #{s.id}
                     </div>
                     <div>
                       <div className="font-medium text-sm text-zinc-200">{s.title}</div>
                       <div className="text-xs text-zinc-500 flex items-center gap-2">
                         <Clock size={10} /> {s.date}
                         <span className="text-zinc-600">•</span>
                         <span className="flex items-center gap-1 text-zinc-400"><Folder size={10} /> {MOCK_WORKSPACES.find(w => w.id === s.workspaceId)?.name}</span>
                       </div>
                     </div>
                   </div>
                   <div className="flex items-center gap-4">
                     <StatusBadge status={s.status} />
                     <ChevronRight size={16} className="text-zinc-600" />
                   </div>
                 </div>
               ))}
             </div>
         </div>
      </div>
   )
}

const OnboardingView = ({ onComplete }) => {
  const [step, setStep] = useState('mode-select'); // mode-select | create-workspace | initializing
  const [mode, setMode] = useState(null);
  const [initStage, setInitStage] = useState(0);

  const handleModeSelect = (selectedMode) => {
    setMode(selectedMode);
    if (selectedMode === 'host') {
       setStep('create-workspace');
    } else {
       onComplete(selectedMode); 
    }
  };

  const handleCreateWorkspace = () => {
    setStep('initializing');
    // Simulate staging
    setTimeout(() => setInitStage(1), 800);
    setTimeout(() => setInitStage(2), 1600);
    setTimeout(() => setInitStage(3), 2400);
    setTimeout(() => setInitStage(4), 3200);
  };

  if (step === 'create-workspace') {
     return (
        <div className="min-h-screen flex flex-col items-center justify-center bg-black text-white p-6 relative">
           <div className="absolute top-0 left-0 w-full h-96 bg-gradient-to-b from-zinc-900 to-transparent opacity-20 pointer-events-none" />
           <div className="max-w-md w-full z-10 space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div className="text-center space-y-2">
                 <div className="w-12 h-12 bg-white rounded-2xl mx-auto flex items-center justify-center shadow-2xl shadow-white/10 mb-6">
                    <FolderPlus size={24} className="text-black" />
                 </div>
                 <h2 className="text-2xl font-bold tracking-tight">Create your first workspace</h2>
                 <p className="text-zinc-400 text-sm leading-relaxed">
                    A workspace is just a <strong>folder</strong> with its own skills, plugins, and tasks.
                 </p>
              </div>

              <div className="space-y-4">
                 <div>
                    <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider block mb-2">Workspace Name</label>
                    <input type="text" defaultValue="My First Workspace" className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-3 text-white focus:outline-none focus:border-white/50 transition-colors" />
                 </div>
                 <div>
                    <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider block mb-2">Location</label>
                    <div className="flex items-center gap-2 w-full bg-zinc-900 border border-zinc-800 rounded-xl p-3 text-zinc-400 cursor-not-allowed">
                       <Folder size={16} />
                       <span className="font-mono text-xs">~/Documents/OpenWork/</span>
                    </div>
                 </div>
              </div>

              <Button onClick={handleCreateWorkspace} className="w-full py-3 text-base">
                 Create Workspace
              </Button>
           </div>
        </div>
     );
  }

  if (step === 'initializing') {
    return (
       <div className="min-h-screen flex flex-col items-center justify-center bg-black text-white p-6 relative overflow-hidden">
          <div className="max-w-sm w-full z-10 space-y-6">
             <div className="text-center space-y-1 mb-8">
                <h2 className="text-xl font-medium">Setting up workspace...</h2>
                <p className="text-zinc-500 text-sm">Populating your folder with superpowers</p>
             </div>

             <div className="space-y-3">
                <div className={`flex items-center gap-3 p-3 rounded-xl border transition-all duration-500 ${initStage >= 1 ? 'bg-zinc-900/50 border-zinc-800 opacity-100' : 'border-transparent opacity-50'}`}>
                   {initStage >= 1 ? <CheckCircle2 size={18} className="text-emerald-500" /> : <Loader2 size={18} className="animate-spin text-zinc-500" />}
                   <span className="text-sm">Installing Scheduler Plugin (Workspace-local)</span>
                </div>
                <div className={`flex items-center gap-3 p-3 rounded-xl border transition-all duration-500 ${initStage >= 2 ? 'bg-zinc-900/50 border-zinc-800 opacity-100' : 'border-transparent opacity-50'}`}>
                   {initStage >= 2 ? <CheckCircle2 size={18} className="text-emerald-500" /> : (initStage === 1 ? <Loader2 size={18} className="animate-spin text-zinc-500" /> : <Circle size={18} className="text-zinc-700" />)}
                   <span className="text-sm">Adding "Workspace Guide" Skill</span>
                </div>
                <div className={`flex items-center gap-3 p-3 rounded-xl border transition-all duration-500 ${initStage >= 3 ? 'bg-zinc-900/50 border-zinc-800 opacity-100' : 'border-transparent opacity-50'}`}>
                   {initStage >= 3 ? <CheckCircle2 size={18} className="text-emerald-500" /> : (initStage === 2 ? <Loader2 size={18} className="animate-spin text-zinc-500" /> : <Circle size={18} className="text-zinc-700" />)}
                   <span className="text-sm">Generating Starter Templates</span>
                </div>
             </div>

             <div className={`transition-all duration-500 ${initStage >= 4 ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}`}>
                <Button onClick={() => onComplete(mode)} className="w-full py-4 text-base bg-white text-black hover:scale-[1.02] shadow-xl shadow-white/10">
                   Go to Dashboard <ArrowRight size={18} />
                </Button>
             </div>
          </div>
       </div>
    );
 }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-black text-white p-6 relative">
       <div className="absolute top-0 left-0 w-full h-96 bg-gradient-to-b from-zinc-900 to-transparent opacity-20 pointer-events-none" />
       <div className="max-w-xl w-full z-10 space-y-12">
        <div className="text-center space-y-4">
          <div className="flex items-center justify-center gap-3 mb-6">
            <div className="w-12 h-12 bg-white rounded-xl flex items-center justify-center">
              <OpenWorkLogo size={24} className="text-black" />
            </div>
            <h1 className="text-3xl font-bold tracking-tight">OpenWork</h1>
          </div>
          <h2 className="text-xl text-zinc-400 font-light">
            How would you like to run OpenWork today?
          </h2>
        </div>
        <div className="space-y-4">
          <button 
            onClick={() => handleModeSelect('host')}
            className="group w-full relative bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 p-6 md:p-8 rounded-3xl text-left transition-all duration-300 hover:shadow-2xl hover:shadow-indigo-500/10 hover:-translate-y-0.5 flex items-start gap-6"
          >
            <div className="shrink-0 w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500/20 to-purple-500/20 flex items-center justify-center border border-indigo-500/20 group-hover:border-indigo-500/40 transition-colors">
              <HardDrive className="text-indigo-400 w-7 h-7" />
            </div>
            <div>
              <h3 className="text-xl font-medium text-white mb-2">Start Host Engine</h3>
              <p className="text-zinc-500 text-sm leading-relaxed mb-4">
                Run OpenCode locally. Best for your primary computer.
              </p>
              <div className="flex items-center gap-2 text-xs font-mono text-indigo-400/80 bg-indigo-900/10 w-fit px-2 py-1 rounded border border-indigo-500/10">
                <div className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
                No setup required
              </div>
            </div>
            <div className="absolute top-8 right-8 text-zinc-700 group-hover:text-zinc-500 transition-colors">
               <ArrowRight size={24} />
            </div>
          </button>
        </div>
      </div>
    </div>
  );
};

const SessionView = ({ initialSession, onBack, activeWorkspace, injectedPrompt }) => {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [formRequest, setFormRequest] = useState(null); // Special modal state
  
  const messagesEndRef = useRef(null);

  useEffect(() => {
     if (injectedPrompt) {
        // Auto-send the template prompt if provided
        setMessages([{ id: Date.now(), role: 'user', content: injectedPrompt }]);
        
        // Mock Response logic based on prompt
        setTimeout(() => {
            let response = "I can help with that.";
            if (injectedPrompt.includes("create a new skill")) {
                response = "I'll help you create a new skill for this workspace. I need a few details to get started.";
                setTimeout(() => {
                    setFormRequest({
                       id: 'form_1',
                       title: 'New Skill Details',
                       fields: [
                          { name: 'name', label: 'Skill Name', placeholder: 'e.g. daily-summarizer' },
                          { name: 'description', label: 'What does it do?', placeholder: 'Summarizes daily logs...' }
                       ]
                    });
                 }, 1500);
            } else if (injectedPrompt.includes("configured")) {
                response = `I'm running inside **${activeWorkspace.name}**. This workspace is a folder located at \`${activeWorkspace.path}\`\n\n**Locally Installed:**\n- Scheduler Plugin\n- Python Runtime\n- Workspace Guide Skill\n\nSessions here are part of your global history but tagged to this workspace.`;
            }
            setMessages(prev => [...prev, { id: Date.now() + 1, role: 'assistant', content: response }]);
        }, 800);
     } else if (initialSession) {
        // Existing session loaded
        if (initialSession.id === 'onboarding-1') {
             // ... existing onboarding logic if needed ...
        }
     }
  }, [initialSession, activeWorkspace, injectedPrompt]);

  const handleSend = () => {
    if (!input.trim()) return;
    setMessages(prev => [...prev, { id: Date.now(), role: 'user', content: input }]);
    setInput('');
    // Mock response
    setTimeout(() => {
       setMessages(prev => [...prev, { id: Date.now()+1, role: 'assistant', content: "I'm working on that..." }]);
    }, 1000);
  };

  const handleFormSubmit = (data) => {
     setFormRequest(null);
     setMessages(prev => [
        ...prev, 
        { id: Date.now(), role: 'system', content: `Tool Output: ${JSON.stringify(data)}`, type: 'audit' },
        { id: Date.now()+1, role: 'assistant', content: `Great. I'm creating the skill "${data.name}". I've generated the SKILL.md and config files.` }
     ]);
  };

  return (
    <div className="h-screen flex flex-col bg-zinc-950 text-white relative">
      <header className="h-14 border-b border-zinc-800 flex items-center justify-between px-4 bg-zinc-950/80 backdrop-blur-md z-10 sticky top-0">
        <div className="flex items-center gap-3">
          <Button variant="ghost" className="!p-1.5 rounded-lg text-zinc-400 hover:text-white" onClick={onBack}>
            <Menu size={20} />
          </Button>
          <div className="h-4 w-px bg-zinc-800 mx-1"></div>
          <div>
            <h2 className="font-semibold text-sm">{initialSession?.title || 'New Session'}</h2>
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-zinc-500 font-medium">
               <span>{activeWorkspace.name}</span>
            </div>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4 md:p-8 scroll-smooth bg-zinc-950">
         <div className="max-w-3xl mx-auto space-y-8 pb-32">
            {messages.map((msg) => (
              <div key={msg.id} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                {msg.type === 'audit' ? (
                   <div className="flex items-center gap-2 text-[10px] text-zinc-600 font-mono py-2 w-full justify-center opacity-80">
                     <Shield size={10} /> {msg.content}
                   </div>
                ) : (
                  <>
                    <div className={`max-w-[85%] ${
                        msg.role === 'user' 
                        ? 'bg-zinc-800 text-white px-4 py-2.5 rounded-2xl rounded-tr-sm' 
                        : 'text-zinc-300 px-0 py-1'
                    }`}>
                        {msg.content.split('\n').map((line, i) => (
                            <p key={i} className={`leading-relaxed ${i > 0 ? "mt-3" : ""}`}>{line}</p>
                        ))}
                    </div>
                  </>
                )}
              </div>
            ))}
            <div ref={messagesEndRef} />
         </div>
      </div>

      <div className="p-4 border-t border-zinc-800 bg-zinc-950 sticky bottom-0 z-20">
        <div className="max-w-3xl mx-auto relative">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder="Message OpenWork..."
            className="w-full bg-zinc-900 border border-zinc-800 rounded-xl py-3.5 pl-4 pr-12 text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-700 transition-colors shadow-sm"
          />
          <button onClick={handleSend} className="absolute right-2 top-2 p-1.5 bg-zinc-800 text-zinc-400 rounded-lg hover:bg-zinc-700 hover:text-white transition-colors">
            <ArrowUp size={18} />
          </button>
        </div>
        <div className="text-center mt-2">
            <p className="text-[10px] text-zinc-600">OpenWork can make mistakes. Check important info.</p>
        </div>
      </div>

      {/* Tool Form Modal */}
      {formRequest && (
         <div className="absolute inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-zinc-900 border border-zinc-800 w-full max-w-md rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in duration-200">
               <div className="p-4 border-b border-zinc-800 bg-zinc-950 flex justify-between items-center">
                  <div className="flex items-center gap-2">
                     <Wrench size={16} className="text-indigo-400" />
                     <span className="font-semibold text-white">{formRequest.title}</span>
                  </div>
               </div>
               <div className="p-6 space-y-4">
                  {formRequest.fields.map(field => (
                     <div key={field.name}>
                        <label className="block text-xs font-medium text-zinc-400 mb-1.5 uppercase">{field.label}</label>
                        <input id={field.name} type="text" placeholder={field.placeholder} className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-white focus:outline-none focus:border-indigo-500" />
                     </div>
                  ))}
                  <div className="pt-2">
                     <Button onClick={() => {
                        const data = {};
                        formRequest.fields.forEach(f => data[f.name] = document.getElementById(f.name).value);
                        handleFormSubmit(data);
                     }} className="w-full bg-indigo-500 hover:bg-indigo-400 text-white">Submit Details</Button>
                  </div>
               </div>
            </div>
         </div>
      )}
    </div>
  );
};

const DashboardView = ({ onStartTask, isHost, onOpenSettings, activeWorkspace, onChangeWorkspace, onNavigate, onViewChange, sessions, onTemplateClick }) => {
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false);
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false);
  const [workspaces, setWorkspaces] = useState(MOCK_WORKSPACES);

  return (
    <div className="flex h-screen bg-zinc-950 text-white overflow-hidden">
      <aside className="w-64 border-r border-zinc-800 flex flex-col justify-between bg-zinc-950 hidden md:flex">
        <div className="p-4">
            <Button onClick={() => onStartTask()} className="w-full bg-zinc-100 text-black hover:bg-white mb-6 justify-between px-3 shadow-none border border-transparent font-normal group">
                <span className="flex items-center gap-2"><Plus size={16} /> New Chat</span>
                <span className="opacity-0 group-hover:opacity-100 transition-opacity"><MessageSquare size={14}/></span>
            </Button>

          <div className="space-y-6">
              <div>
                <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2 px-2">Apps</h3>
                <nav className="space-y-0.5">
                    {[
                    { icon: Layout, label: 'Home', id: 'dashboard', active: true },
                    { icon: LayoutTemplate, label: 'Templates', id: 'templates' },
                    { icon: Package, label: 'Extensions', id: 'plugins' },
                    ].map((item) => (
                    <button 
                        key={item.label}
                        onClick={() => onViewChange(item.id)}
                        className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg text-sm font-medium transition-colors ${item.active ? 'bg-zinc-900 text-white' : 'text-zinc-400 hover:text-white hover:bg-zinc-900/50'}`}
                    >
                        <item.icon size={16} />
                        {item.label}
                    </button>
                    ))}
                </nav>
              </div>

              <div>
                <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2 px-2">History</h3>
                <div className="space-y-0.5 max-h-64 overflow-y-auto">
                    {sessions.slice(0, 5).map(s => (
                        <button key={s.id} onClick={() => onNavigate(s)} className="w-full text-left px-2 py-2 rounded-lg text-sm text-zinc-400 hover:bg-zinc-900/50 hover:text-white truncate transition-colors">
                            {s.title}
                        </button>
                    ))}
                </div>
              </div>
          </div>
        </div>

        <div className="p-4 border-t border-zinc-800 space-y-3">
             <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-zinc-900/50 border border-zinc-800/50">
               <div className="w-1.5 h-1.5 rounded-full bg-emerald-500"></div>
               <span className="text-xs font-medium text-zinc-400">Engine Active</span>
             </div>
             <button onClick={onOpenSettings} className="flex items-center gap-2 text-sm text-zinc-500 hover:text-white px-2">
                 <Settings size={16} /> Settings
             </button>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto relative bg-zinc-950">
        <header className="h-14 flex items-center justify-between px-6 border-b border-zinc-800 sticky top-0 bg-zinc-950/80 backdrop-blur-md z-10">
          <div className="flex items-center gap-4">
            <div className="md:hidden"><Menu className="text-zinc-400" /></div>
            <WorkspaceChip 
               activeWorkspace={activeWorkspace} 
               onClick={() => setShowWorkspacePicker(true)} 
            />
          </div>
        </header>

        <div className="p-6 md:p-10 max-w-5xl mx-auto space-y-12">
          <section className="text-center py-10 mt-10">
             <div className="w-12 h-12 bg-white rounded-2xl mx-auto flex items-center justify-center mb-6 shadow-xl shadow-white/5">
                <OpenWorkLogo size={24} className="text-black" />
             </div>
             <h2 className="text-2xl font-medium text-white mb-2">How can I help you today?</h2>
          </section>

          <section>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-w-3xl mx-auto">
              {MOCK_TEMPLATES.slice(0, 4).map((t) => (
                <button 
                  key={t.id} 
                  onClick={() => onTemplateClick(t)}
                  className="group p-4 rounded-xl border border-zinc-800 hover:bg-zinc-900/50 hover:border-zinc-700 transition-all text-left flex items-start gap-3 bg-zinc-900/20"
                >
                  <div className="mt-0.5 text-zinc-500 group-hover:text-zinc-300 transition-colors">
                     {t.icon === 'help-circle' && <Shield size={16} />}
                     {t.icon === 'sparkles' && <Sparkles size={16} />}
                     {t.icon === 'clock' && <Clock size={16} />}
                     {t.icon === 'save' && <Download size={16} />}
                  </div>
                  <div>
                    <h4 className="font-medium text-sm text-zinc-300 group-hover:text-white mb-0.5">{t.title}</h4>
                    <p className="text-xs text-zinc-500 line-clamp-1">{t.description}</p>
                  </div>
                </button>
              ))}
            </div>
          </section>
        </div>

        <WorkspacePicker 
          isOpen={showWorkspacePicker}
          onClose={() => setShowWorkspacePicker(false)}
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspace.id}
          onSelect={onChangeWorkspace}
          onCreateNew={() => setShowCreateWorkspace(true)}
        />
        
        <CreateWorkspaceModal 
          isOpen={showCreateWorkspace}
          onClose={() => setShowCreateWorkspace(false)}
          onConfirm={() => {}}
        />
      </main>
    </div>
  );
};

// --- Main App Controller ---

export default function App() {
  const [view, setView] = useState('loading'); 
  const [mode, setMode] = useState(null); 
  const [activeWorkspaceId, setActiveWorkspaceId] = useState('starter');
  const [workspaces, setWorkspaces] = useState(MOCK_WORKSPACES);
  const [currentSession, setCurrentSession] = useState(null);
  const [sessions, setSessions] = useState(MOCK_SESSIONS);
  const [injectedPrompt, setInjectedPrompt] = useState(null);

  const activeWorkspace = workspaces.find(w => w.id === activeWorkspaceId) || workspaces[0];

  useEffect(() => {
    const pref = localStorage.getItem('openwork_mode_pref');
    if (pref) {
      setTimeout(() => {
        setMode(pref);
        setView('dashboard');
      }, 800);
    } else {
      setView('onboarding');
    }
  }, []);

  const handleOnboardingComplete = (selectedMode) => {
    setMode(selectedMode);
    setView('dashboard'); // Go to dashboard, don't auto-start session
  };

  const handleStartTask = (prompt = null) => {
    const newSession = { id: Date.now(), title: prompt ? prompt.slice(0, 20) + '...' : 'New Task', workspaceId: activeWorkspaceId };
    setCurrentSession(newSession);
    setSessions([newSession, ...sessions]);
    setInjectedPrompt(prompt); // Pass prompt to session view
    setView('session');
  };
  
  const handleCreateSkill = (title, prompt) => {
     handleStartTask(prompt);
  };

  const handleOpenSession = (s) => {
      setCurrentSession(s);
      setInjectedPrompt(null);
      setView('session');
  };

  const handleTemplateClick = (template) => {
      handleStartTask(template.prompt);
  };

  return (
    <div className="antialiased font-sans bg-zinc-950 min-h-screen text-zinc-100 selection:bg-white/20">
      {view === 'onboarding' && <OnboardingView onComplete={handleOnboardingComplete} />}
      
      {view === 'dashboard' && (
        <DashboardView 
          onStartTask={() => handleStartTask()} 
          isHost={mode === 'host'} 
          activeWorkspace={activeWorkspace}
          onChangeWorkspace={setActiveWorkspaceId}
          onViewChange={setView}
          sessions={sessions}
          onNavigate={handleOpenSession}
          onTemplateClick={handleTemplateClick}
        />
      )}

      {/* Global Sidebar Wrapper for Non-Dashboard Views */}
      {['skills', 'plugins', 'sessions'].includes(view) && (
         <div className="flex h-screen bg-zinc-950 text-white overflow-hidden">
            <aside className="w-64 border-r border-zinc-800 flex flex-col justify-between bg-zinc-950 hidden md:flex">
               <div className="p-4">
                 <Button onClick={() => handleStartTask()} className="w-full bg-zinc-100 text-black hover:bg-white mb-6 justify-between px-3 shadow-none border border-transparent font-normal group">
                    <span className="flex items-center gap-2"><Plus size={16} /> New Chat</span>
                    <span className="opacity-0 group-hover:opacity-100 transition-opacity"><MessageSquare size={14}/></span>
                 </Button>
                 
                 <div className="space-y-6">
                    <div>
                        <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2 px-2">Apps</h3>
                        <nav className="space-y-0.5">
                            {[
                            { icon: Layout, label: 'Home', id: 'dashboard' },
                            { icon: LayoutTemplate, label: 'Templates', id: 'templates' },
                            { icon: Package, label: 'Extensions', id: 'plugins', active: view === 'plugins' || view === 'skills' },
                            ].map((item) => (
                            <button 
                                key={item.label}
                                onClick={() => setView(item.id)}
                                className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg text-sm font-medium transition-colors ${item.active ? 'bg-zinc-900 text-white' : 'text-zinc-400 hover:text-white hover:bg-zinc-900/50'}`}
                            >
                                <item.icon size={16} />
                                {item.label}
                            </button>
                            ))}
                        </nav>
                    </div>
                    <div>
                        <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2 px-2">History</h3>
                        <div className="space-y-0.5 max-h-64 overflow-y-auto">
                            {sessions.slice(0, 5).map(s => (
                                <button key={s.id} onClick={() => handleOpenSession(s)} className="w-full text-left px-2 py-2 rounded-lg text-sm text-zinc-400 hover:bg-zinc-900/50 hover:text-white truncate transition-colors">
                                    {s.title}
                                </button>
                            ))}
                        </div>
                    </div>
                 </div>
               </div>
            </aside>
            <div className="flex-1">
               {view === 'skills' && <ExtensionsView activeWorkspace={activeWorkspace} onCreateSkill={handleCreateSkill} />}
               {view === 'plugins' && <ExtensionsView activeWorkspace={activeWorkspace} onCreateSkill={handleCreateSkill} />} 
               {view === 'sessions' && <SessionsListView onOpenSession={handleOpenSession} sessions={sessions} />}
            </div>
         </div>
      )}
      
      {view === 'session' && (
        <SessionView 
          initialSession={currentSession}
          onBack={() => setView('dashboard')} 
          activeWorkspace={activeWorkspace}
          injectedPrompt={injectedPrompt}
        />
      )}
    </div>
  );
}
