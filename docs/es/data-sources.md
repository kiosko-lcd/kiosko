# Fuentes de datos y perfiles

Muchos widgets no traen sus datos ellos mismos: leen una **fuente de datos
compartida** (`plugin/fuente`), que se lee una vez para todos los widgets que
la usan. El mazo de noticias (`news/deck`), el tiempo, tus calendarios, un Home
Assistant: cada uno es una fuente. Sus ajustes están en el editor, en
**Ajustes → Fuentes de datos**; cada línea dice cada cuánto se lee y cómo fue
la última lectura.

Una fuente solo corre mientras algún widget de una pantalla activa la usa. Las
que pueden dar avisos (alertas meteorológicas, terremotos) también pueden
correr sin widget: **Vigilar avisos sin widget**.

## Perfiles: una fuente, varias configuraciones

Algunas fuentes admiten **perfiles**: varias configuraciones con nombre de la
misma fuente, cada una con sus opciones y leída por separado. Una pantalla
enseña noticias generales y otra de tecnología; una tesela, tu cuenta de
GitHub del trabajo y otra la personal. Cada fuente dice si los admite; las que
leen algo único de esta máquina (una batería, un sensor) no.

- **Ajustes → Fuentes de datos**: una fuente con perfiles los muestra como
  pestañas. **Por defecto** es la configuración que leen todos los widgets que
  no eligen otra. **+ Perfil** añade uno; cada pestaña se puede renombrar,
  duplicar o borrar (dice cuántas teselas lo leen; esas vuelven al perfil por
  defecto).
- **En una tesela**: el inspector muestra **Perfil de la fuente**. Elige uno, o
  **Nuevo perfil…**, que copia el que lee ahora el widget, le pone nombre y
  deja cambiar sus opciones allí mismo (**Editar perfil**).

Cada perfil tiene sus datos, su intervalo y su estado: en el inspector de un
widget la línea de datos dice `news/deck#tecnologia`. Las opciones de un perfil
las comparten todas las teselas que lo leen.

### Noticias por tema

El mazo de noticias tiene perfiles: «General» con las portadas, «Tecnología»
con las secciones de tecnología (cada periódico tiene un RSS por sección),
«Deportes»… Cada perfil agrupa sus propias noticias, así que «lo cuentan 4
medios» cuenta dentro del perfil, y un feed que esté en dos perfiles se
descarga una sola vez.

Sin perfiles, un widget de noticias también puede quedarse solo con algunas
con **Temas**: palabras que se buscan en el titular y la entradilla, separadas
por comas, con `!` delante para excluir (`fútbol, liga, !apuestas`). Da igual
mayúsculas y tildes, y la palabra casa al principio de palabra (`ia` encuentra
«IA», no «familia»).

## En el fichero de configuración

```json
{
  "sources": { "news/deck": { "feeds": [ { "name": "El País", "url": "https://…/portada" } ] } },
  "sourceProfiles": {
    "news/deck": {
      "tecnologia": { "name": "Tecnología", "options": { "feeds": [ { "name": "Xataka", "url": "https://www.xataka.com/feedburner.xml" } ] } }
    }
  }
}
```

y en el widget, `"profile": "tecnologia"`. `sources["plugin/fuente"]` es
siempre el perfil por defecto: una configuración sin `sourceProfiles` funciona
exactamente como antes. Un widget cuyo perfil ya no existe lee el por defecto,
y `kiosko config check` lo avisa.

Para quien escribe plugins: declara `profiles: true` en la fuente (ver
[Escribir plugins](../plugins.md#shared-sources)); los widgets no cambian,
encuentran los datos del perfil en `ctx.sources["plugin/fuente"]`, y
`ctx.profile` le dice a la fuente cuál está leyendo.
