import { createContext, useContext } from 'react';

export type Lang = 'de' | 'en' | 'fr';

export const LANGUAGES: { code: Lang; label: string }[] = [
  { code: 'de', label: 'DE' },
  { code: 'en', label: 'EN' },
  { code: 'fr', label: 'FR' },
];

const de = {
  app: {
    titleTop: 'Opti',
    titleBottom: 'Gate',
    slogan: 'Dein optimiertes MCP Gateway',
    views: {
      servers: 'Server',
      tools: 'Tools',
      audit: 'Audit',
    },
    register: 'Registrieren',
    reload: 'Liste neu laden',
    viewNav: 'Ansichten',
  },
  stats: {
    servers: 'Server',
    healthy: 'Aktiv',
  },
  search: {
    placeholder: 'Server oder Beschreibung suchen …',
    reset: 'Suche zurücksetzen',
    srLabel: 'Server suchen',
    noResultsTitle: 'Keine Treffer für',
    noResultsHint:
      'Andere Begriffe versuchen oder die Suche zurücksetzen.',
  },
  empty: {
    title: 'Noch keine MCP-Server',
    hint: 'Registriere deinen ersten Server, um loszulegen.',
  },
  card: {
    status: {
      healthy: 'Aktiv',
      degraded: 'Degraded',
      offline: 'Offline',
      disabled: 'Deaktiviert',
      pending_approval: 'Wartet auf Freigabe',
    },
    noDescription: 'Keine Beschreibung',
    tools: 'Tools',
    more: 'weitere …',
    less: 'Weniger anzeigen',
    connect: 'Verbinden',
    connecting: 'Verbinde …',
    refreshTools: 'Tools aktualisieren',
    loading: 'Lade …',
    disconnect: 'Trennen',
    disconnectTitle:
      'Verbindung trennen (Tools werden aus dem Index entfernt)',
    edit: 'Bearbeiten',
    approve: 'Freigeben',
    enable: 'Aktivieren',
    enableTitle: 'Server wieder aktivieren (Admin)',
    disable: 'Deaktivieren',
    delete: 'Löschen',
    connectTitle: 'Verbindung herstellen & Tools abrufen',
    refreshTitle: 'Tool-Liste neu vom Server abrufen',
  },
  toolSearch: {
    heading: 'Tool-Suche',
    intro1: 'Gleicher Retrieval-Pfad wie das Meta-Tool',
    intro2: 'des Gateways — so sehen Agenten die Registry.',
    placeholder: 'z. B. chart, gold, web search …',
    submit: 'Suchen',
    srLabel: 'Tools suchen',
    resultsHeader: 'Treffer · Score-Ranking wie bei Agenten',
    empty: 'Keine Tools im Index passen zu dieser Suche.',
  },
  audit: {
    time: 'Zeit',
    action: 'Aktion',
    actor: 'Akteur',
    detail: 'Detail',
    empty: 'Noch keine Ereignisse',
  },
  dialog: {
    editTitle: 'Server bearbeiten',
    registerTitle: 'MCP Server registrieren',
    name: 'Name',
    namePlaceholder: 'z. B. rag-search',
    description: 'Beschreibung',
    descriptionPlaceholder: 'Wofür ist dieser Server gut? (Basis für die Tool-Suche)',
    scope: 'Scope',
    scopeOptions: {
      tenant: 'Tenant',
      global: 'Global',
      private: 'Privat',
    },
    transport: 'Transport',
    command: 'Kommando',
    args: 'Argumente',
    argsHint:
      'Durch Leerzeichen getrennt. Pfade mit Leerzeichen in Anführungszeichen.',
    url: 'URL',
    customHeaders: 'Eigene Header',
    customHeadersHint:
      'Zusätzliche Key-Value-Header für jede Anfrage — unabhängig von der gewählten Authentifizierung.',
    headerName: 'Header-Name',
    headerValue: 'Header-Wert',
    removeHeader: 'Header entfernen',
    addHeader: 'Header hinzufügen',
    auth: 'Authentifizierung',
    authType: 'Typ',
    authOptions: {
      none: 'Keine',
      bearer: 'Bearer Token',
      api_key: 'API Key',
      custom_headers: 'Eigene Header',
      oauth2: 'OAuth2 (Client Credentials)',
    },
    secretModeRef: 'Umgebungsvariable',
    secretModeDirect: 'Direkteingabe',
    secretVarName: 'Variablenname',
    secretVarHint: 'Wert wird beim Verbinden aus der Umgebung gelesen.',
    secret: 'Secret',
    secretEncHint:
      'Wird verschlüsselt gespeichert (AES-256-GCM) und niemals im Klartext wieder angezeigt.',
    headerNameField: 'Header-Name',
    tokenUrl: 'Token URL',
    clientId: 'Client ID',
    clientSecretEnv: 'Client Secret (Env-Var)',
    clientSecret: 'Client Secret',
    cancel: 'Abbrechen',
    save: 'Speichern',
    close: 'Schließen',
  },
};

type Dict = typeof de;

const en: Dict = {
  app: {
    titleTop: 'Opti',
    titleBottom: 'Gate',
    slogan: 'Your optimized MCP gateway',
    views: {
      servers: 'Servers',
      tools: 'Tools',
      audit: 'Audit',
    },
    register: 'Register',
    reload: 'Reload list',
    viewNav: 'Views',
  },
  stats: {
    servers: 'Servers',
    healthy: 'Active',
  },
  search: {
    placeholder: 'Search servers or descriptions …',
    reset: 'Reset search',
    srLabel: 'Search servers',
    noResultsTitle: 'No matches for',
    noResultsHint: 'Try different terms or reset the search.',
  },
  empty: {
    title: 'No MCP servers yet',
    hint: 'Register your first server to get started.',
  },
  card: {
    status: {
      healthy: 'Active',
      degraded: 'Degraded',
      offline: 'Offline',
      disabled: 'Disabled',
      pending_approval: 'Awaiting approval',
    },
    noDescription: 'No description',
    tools: 'Tools',
    more: 'more …',
    less: 'Show less',
    connect: 'Connect',
    connecting: 'Connecting …',
    refreshTools: 'Refresh tools',
    loading: 'Loading …',
    disconnect: 'Disconnect',
    disconnectTitle: 'Disconnect (tools are removed from the index)',
    edit: 'Edit',
    approve: 'Approve',
    enable: 'Enable',
    enableTitle: 'Re-enable this server (admin)',
    disable: 'Disable',
    delete: 'Delete',
    connectTitle: 'Establish connection & fetch tools',
    refreshTitle: 'Fetch the tool list from the server again',
  },
  toolSearch: {
    heading: 'Tool search',
    intro1: 'Same retrieval path as the gateway meta-tool',
    intro2: '— this is what agents see when they query the registry.',
    placeholder: 'e.g. chart, gold, web search …',
    submit: 'Search',
    srLabel: 'Search tools',
    resultsHeader: 'matches · score ranking as agents see it',
    empty: 'No tools in the index match this search.',
  },
  audit: {
    time: 'Time',
    action: 'Action',
    actor: 'Actor',
    detail: 'Detail',
    empty: 'No events yet',
  },
  dialog: {
    editTitle: 'Edit server',
    registerTitle: 'Register MCP server',
    name: 'Name',
    namePlaceholder: 'e.g. rag-search',
    description: 'Description',
    descriptionPlaceholder: 'What is this server good for? (basis for tool search)',
    scope: 'Scope',
    scopeOptions: {
      tenant: 'Tenant',
      global: 'Global',
      private: 'Private',
    },
    transport: 'Transport',
    command: 'Command',
    args: 'Arguments',
    argsHint: 'Separated by spaces. Quote paths containing spaces.',
    url: 'URL',
    customHeaders: 'Custom headers',
    customHeadersHint:
      'Additional key/value headers on every request — independent of the chosen authentication.',
    headerName: 'Header name',
    headerValue: 'Header value',
    removeHeader: 'Remove header',
    addHeader: 'Add header',
    auth: 'Authentication',
    authType: 'Type',
    authOptions: {
      none: 'None',
      bearer: 'Bearer token',
      api_key: 'API key',
      custom_headers: 'Custom headers',
      oauth2: 'OAuth2 (client credentials)',
    },
    secretModeRef: 'Environment variable',
    secretModeDirect: 'Direct entry',
    secretVarName: 'Variable name',
    secretVarHint: 'The value is read from the environment when connecting.',
    secret: 'Secret',
    secretEncHint:
      'Stored encrypted (AES-256-GCM) and never displayed in plaintext again.',
    headerNameField: 'Header name',
    tokenUrl: 'Token URL',
    clientId: 'Client ID',
    clientSecretEnv: 'Client secret (env var)',
    clientSecret: 'Client secret',
    cancel: 'Cancel',
    save: 'Save',
    close: 'Close',
  },
};

const fr: Dict = {
  app: {
    titleTop: 'Opti',
    titleBottom: 'Gate',
    slogan: 'Votre passerelle MCP optimisée',
    views: {
      servers: 'Serveurs',
      tools: 'Outils',
      audit: 'Audit',
    },
    register: 'Enregistrer',
    reload: 'Recharger la liste',
    viewNav: 'Vues',
  },
  stats: {
    servers: 'Serveurs',
    healthy: 'Actifs',
  },
  search: {
    placeholder: 'Rechercher des serveurs ou des descriptions …',
    reset: 'Réinitialiser la recherche',
    srLabel: 'Rechercher des serveurs',
    noResultsTitle: 'Aucun résultat pour',
    noResultsHint: 'Essayez d’autres termes ou réinitialisez la recherche.',
  },
  empty: {
    title: 'Aucun serveur MCP pour le moment',
    hint: 'Enregistrez votre premier serveur pour commencer.',
  },
  card: {
    status: {
      healthy: 'Actif',
      degraded: 'Dégradé',
      offline: 'Hors ligne',
      disabled: 'Désactivé',
      pending_approval: 'En attente d’approbation',
    },
    noDescription: 'Aucune description',
    tools: 'Outils',
    more: 'autres …',
    less: 'Réduire',
    connect: 'Connecter',
    connecting: 'Connexion …',
    refreshTools: 'Actualiser les outils',
    loading: 'Chargement …',
    disconnect: 'Déconnecter',
    disconnectTitle:
      'Déconnecter (les outils sont retirés de l’index)',
    edit: 'Modifier',
    approve: 'Approuver',
    enable: 'Activer',
    enableTitle: 'Réactiver ce serveur (admin)',
    disable: 'Désactiver',
    delete: 'Supprimer',
    connectTitle: 'Établir la connexion et récupérer les outils',
    refreshTitle: 'Récupérer à nouveau la liste des outils du serveur',
  },
  toolSearch: {
    heading: 'Recherche d’outils',
    intro1: 'Même chemin de récupération que l’outil méta',
    intro2: 'du passerelle — voilà ce que voient les agents.',
    placeholder: 'p. ex. chart, gold, web search …',
    submit: 'Rechercher',
    srLabel: 'Rechercher des outils',
    resultsHeader: 'résultats · classement par score comme pour les agents',
    empty: 'Aucun outil de l’index ne correspond à cette recherche.',
  },
  audit: {
    time: 'Heure',
    action: 'Action',
    actor: 'Acteur',
    detail: 'Détail',
    empty: 'Aucun événement pour le moment',
  },
  dialog: {
    editTitle: 'Modifier le serveur',
    registerTitle: 'Enregistrer un serveur MCP',
    name: 'Nom',
    namePlaceholder: 'p. ex. rag-search',
    description: 'Description',
    descriptionPlaceholder:
      'À quoi sert ce serveur ? (base de la recherche d’outils)',
    scope: 'Portée',
    scopeOptions: {
      tenant: 'Locataire',
      global: 'Globale',
      private: 'Privée',
    },
    transport: 'Transport',
    command: 'Commande',
    args: 'Arguments',
    argsHint: 'Séparés par des espaces. Mettez les chemins entre guillemets.',
    url: 'URL',
    customHeaders: 'En-têtes personnalisés',
    customHeadersHint:
      'En-têtes clé/valeur supplémentaires pour chaque requête — indépendants de l’authentification choisie.',
    headerName: "Nom de l'en-tête",
    headerValue: "Valeur de l'en-tête",
    removeHeader: "Supprimer l'en-tête",
    addHeader: 'Ajouter un en-tête',
    auth: 'Authentification',
    authType: 'Type',
    authOptions: {
      none: 'Aucune',
      bearer: 'Jeton Bearer',
      api_key: 'Clé API',
      custom_headers: 'En-têtes personnalisés',
      oauth2: 'OAuth2 (identifiants client)',
    },
    secretModeRef: 'Variable d’environnement',
    secretModeDirect: 'Saisie directe',
    secretVarName: 'Nom de la variable',
    secretVarHint:
      'La valeur est lue depuis l’environnement lors de la connexion.',
    secret: 'Secret',
    secretEncHint:
      'Stocké chiffré (AES-256-GCM) et jamais affiché en clair à nouveau.',
    headerNameField: "Nom de l'en-tête",
    tokenUrl: 'URL du jeton',
    clientId: 'ID client',
    clientSecretEnv: 'Secret client (var. d’env.)',
    clientSecret: 'Secret client',
    cancel: 'Annuler',
    save: 'Enregistrer',
    close: 'Fermer',
  },
};

const dictionaries: Record<Lang, Dict> = { de, en, fr };

export function dictionary(lang: Lang): Dict {
  return dictionaries[lang];
}

export type Translation = Dict;

export const LangContext = createContext<Lang>('de');

export function useT(): Dict {
  const lang = useContext(LangContext);
  return dictionaries[lang] ?? de;
}

export function useLang(): Lang {
  return useContext(LangContext);
}
