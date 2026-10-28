# SAX Power Home pour Gladys

Connecteur **non officiel**, sans lien avec SAX Power. Il lit vos batteries
**SAX Power Home** ou **Home Plus** sur votre réseau local par leur interface
**Modbus TCP** (port 502) : une batterie seule, ou un groupe de trois au plus
(la maîtresse A et les autres). **Lecture seule** : il ne change jamais un
réglage et ne pilote pas la batterie. Pas de cloud.

**Jamais testé avec un vrai appareil.** Vos retours sont les bienvenus.

## Ce que vous obtenez

Pour **chaque batterie** (registres lus par sax_battery_ha, unités Modbus 64
et 40) :

- état de charge (%), puissance de la batterie (W, signée telle que la
  batterie la donne : le sens de charge et de décharge n'est pas documenté
  par SAX), code d'état ;
- température, nombre de cycles, capacité (kWh) ;
- deux compteurs d'énergie, « énergie produite » et « énergie consommée »
  (kWh), **affichés seulement** : ils ne vont pas au suivi énergétique de
  Gladys (leur sens et leur unité ne sont pas documentés par SAX).

Pour la **batterie A (maîtresse)**, en plus, les valeurs du **système entier**
par l'interface SunSpec documentée par SAX (firmware Master V61 / Gateway V54
ou plus récent) :

- état de charge du système, puissance du stockage (W, signée), température
  de cellule la plus haute, état (1 arrêt, 2 veille, 3 attente, 4 marche,
  7 défaut compteur), événements ;
- puissances de charge et de décharge disponibles, capacité du système ;
- avec le compteur **ADW200** seulement : puissance solaire et puissance du
  réseau (W, signée telle que le compteur la donne). Sans ADW200 (tension du
  réseau lue sous 100 V), ces deux valeurs ne sont pas publiées.

SAX conseille de ne lire que la maîtresse d'un groupe : elle donne déjà les
valeurs du système. Ajoutez B et C seulement pour voir les valeurs propres de
chaque batterie.

## Installation

1. Activez l'interface Modbus TCP de vos batteries si elle ne l'est pas (le
   service client de SAX Power le fait ; une mise à jour du firmware peut
   être nécessaire pour l'interface SunSpec).
2. Donnez à chaque batterie une **adresse fixe** dans votre box (elle prend son
   adresse par DHCP ; l'adresse s'affiche sur son écran).
3. Dans Gladys, installez l'intégration, saisissez l'adresse de la batterie A,
   puis celles de B et C s'il y a lieu, et enregistrez.
4. Onglet « Découverte » : créez l'appareil de chaque batterie. Ses valeurs
   arrivent à la lecture suivante.

## Lecture

- Chaque batterie est lue toutes les 30 s par défaut (15 à 300 s), sur sa
  propre connexion, une requête à la fois et 500 ms au moins entre deux
  requêtes, comme SAX le demande. Les batteries sont lues côte à côte : une
  batterie qui ne répond pas ne retarde pas les autres.
- Jamais plus vite que l'intervalle : ni le bouton de test, ni la Découverte,
  ni une reconnexion à Gladys, ni un redémarrage du conteneur (la première
  lecture attend alors l'intervalle et une minute après la dernière lecture). Seule une **nouvelle
  adresse** enregistrée est lue tout de suite.
- Pendant le rafraîchissement de son écran, la batterie ne répond pas 1 à
  3 s : la partie non lue manque cette fois, l'état le dit (« non lu cette
  fois »), le reste est publié. Une partie qui échoue trois lectures de suite
  est sautée pendant dix lectures (jamais le numéro de série d'une batterie
  déjà connue par son numéro de série).
- Une batterie injoignable : nouvel essai après 1 min au moins, puis un
  délai doublé jusqu'à 15 min.

## Identité de chaque batterie

- Chaque lecture lit le **numéro de série** de l'interface SunSpec (avec ses
  valeurs fixes « SunS », modèle 1 de longueur 15 et « SAXPOWER ») ; si la
  lecture doit ouvrir une nouvelle connexion, elle le relit d'abord, et une
  autre batterie à cette adresse n'y donne rien. Les valeurs ne vont qu'à
  l'appareil de ce numéro.
- Une batterie sans interface SunSpec (firmware plus ancien, ou batterie d'un
  groupe qui la laisse à la maîtresse) prend le nom de son adresse
  (`ip192-168-1-51-502`) après trois lectures où son unité 64 a répondu et
  son numéro de série non. Si un numéro de série apparaît plus tard, il
  l'emporte : un nouvel appareil apparaît dans la Découverte, l'ancien garde
  son historique.
- Une batterie dont le numéro de série est connu et qui ne le donne pas cette
  fois : rien n'est publié pour elle (jamais à l'appareil de son adresse).
- Un autre numéro de série à la même adresse : c'est une autre batterie, son
  propre appareil apparaît dans la Découverte ; l'ancien ne reçoit plus de
  valeur.

## Compteurs d'énergie

Les deux compteurs « énergie produite » et « énergie consommée » de chaque
batterie sont publiés **tels que lus**, en capteurs simples (kWh), jamais
comptés par le suivi énergétique. SAX ne documente ni leur sens, ni leur
unité, ni leur nature : ce sont des registres de 16 bits qui peuvent
**repartir de zéro** (vers 65,5 kWh s'ils sont en Wh) ou être **périodiques**
(remis à zéro régulièrement). À confirmer sur une vraie batterie. Une valeur 0
est tenue pour inconnue et n'est jamais publiée.

## Ce qui n'est pas fait

- Aucun pilotage : pas de limite de charge ou de décharge, pas de consigne de
  puissance (le « mode pilote » de sax_battery_ha n'est pas porté).
- Pas d'index pour le suivi énergétique de Gladys.

## Dépannage

- « injoignable » : vérifiez l'adresse et le port (502), et que la batterie
  est sur le même réseau.
- « connecté, mais aucun registre n'a répondu » : l'interface Modbus n'est
  sans doute pas activée ; voyez avec le service client de SAX Power.
- « numéro de série (SunSpec) » toujours non lu sur la maîtresse : le firmware
  est sans doute plus ancien que Master V61 / Gateway V54 ; les valeurs du
  système manquent alors.
- /data illisible : le fichier est laissé tel quel, aucune batterie ne prend le
  nom de son adresse (une batterie identifiée par son numéro de série reste
  lue) ; redémarrez l'intégration.
