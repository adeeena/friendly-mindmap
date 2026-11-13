# Forward WAN HTTPS to Caddy and HTTP port 6610 to its HTTPS redirect listener.
# Replace WAN with the actual WAN interface list if the router uses another name.

/ip firewall nat remove [find where comment="Friendly Mindmap HTTPS"]
/ip firewall nat remove [find where comment="Friendly Mindmap HTTP redirect"]
/ip firewall filter remove [find where comment="Allow Friendly Mindmap HTTPS"]
/ip firewall filter remove [find where comment="Allow Friendly Mindmap HTTP redirect"]

/ip firewall nat add chain=dstnat in-interface-list=WAN protocol=tcp dst-port=443 action=dst-nat to-addresses=192.168.88.100 to-ports=443 comment="Friendly Mindmap HTTPS"
/ip firewall nat add chain=dstnat in-interface-list=WAN protocol=tcp dst-port=6610 action=dst-nat to-addresses=192.168.88.100 to-ports=6610 comment="Friendly Mindmap HTTP redirect"

/ip firewall filter add chain=forward in-interface-list=WAN connection-nat-state=dstnat protocol=tcp dst-address=192.168.88.100 dst-port=443 action=accept place-before=0 comment="Allow Friendly Mindmap HTTPS"
/ip firewall filter add chain=forward in-interface-list=WAN connection-nat-state=dstnat protocol=tcp dst-address=192.168.88.100 dst-port=6610 action=accept place-before=0 comment="Allow Friendly Mindmap HTTP redirect"
