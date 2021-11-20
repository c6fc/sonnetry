{
	local aws = self,

	client(service, params={}):: {
		service: service,
		params: params
	},

	api(clientObj, method, params=""):: std.native("aws")(
		std.manifestJsonEx(clientObj, ''),
		method,
		std.manifestJsonEx(params, '')
	)
}